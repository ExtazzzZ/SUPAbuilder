import {
  and,
  type DatabaseClient,
  db,
  eq,
  sql,
} from "@chatbotx.io/database/client"
import {
  flowModel,
  flowRunModel,
  flowVersionModel,
  supacrmSourceFlowBindingModel,
  workspaceModel,
} from "@chatbotx.io/database/schema"
import { z } from "zod"

const localId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
const flowScope = z.object({ workspaceId: localId, flowId: localId }).strict()
const bindingTarget = flowScope.extend({ registryId: z.uuid() }).strict()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const admissionSchema = z
  .object({
    target: bindingTarget,
    bindingVersion: z.literal(1),
    policy: z.literal("source_only_v1"),
    authorizationId: z.uuid(),
    actorDigest: digest,
    policyDigest: digest,
  })
  .strict()

export type SourceFlowScope = z.infer<typeof flowScope>
export type SourceBindingTarget = z.infer<typeof bindingTarget>
export type SourceBindingAdmission = z.infer<typeof admissionSchema>

/** Это возможности протокола, а не разрешение текущему пользователю. */
export const sourceDocumentCapabilities = Object.freeze([
  "view",
  "slot",
  "compile",
  "validate",
  "publish",
] as const)

export type DocumentBinding =
  | ({ kind: "legacy" } & SourceFlowScope)
  | ({
      kind: "source"
      bindingId: string
      registryId: string
      bindingVersion: 1
      capabilities: typeof sourceDocumentCapabilities
    } & SourceFlowScope)
  | { kind: "blocked"; code: "source_binding_unavailable" }

export type LegacyFlowOperation =
  | "updateDraft"
  | "publish"
  | "restore"
  | "revert"
  | "duplicate"
  | "delete"
  | "execute"

/** Создаётся сервером с проверенной identity/capability, не из request body. */
export interface SourceBindingAuthority {
  authorizeBinding(input: {
    target: Readonly<SourceBindingTarget>
    tx: DatabaseClient
  }): Promise<SourceBindingAdmission>
}

export class SourceFlowBindingDenied extends Error {
  constructor() {
    super("source_binding_denied")
    this.name = "SourceFlowBindingDenied"
  }
}

type PgClient = { query: (...args: unknown[]) => unknown }
type TransactionInternals = {
  session: { client: PgClient }
  nestedIndex: number
  rollback?: () => never
}
const allowedStatement = /^(select|insert|update|delete|with|show)\b/i

function queryText(first: unknown): string {
  if (typeof first === "string") {
    return first
  }
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof first.text === "string"
  ) {
    return first.text
  }
  return ""
}

/**
 * Адаптер закреплённого Drizzle node-postgres: наблюдается физический клиент,
 * а ROOT сверяется с PostgreSQL. Неподдерживаемый driver закрывает доступ.
 */
class BindingUnitOfWork {
  private readonly internals: TransactionInternals
  private readonly session: TransactionInternals["session"]
  private readonly client: PgClient
  private readonly query: PgClient["query"]
  private readonly guardedQuery: PgClient["query"]
  private readonly rollback: TransactionInternals["rollback"]
  private violated = false
  private fingerprint?: string
  private readonly tx: DatabaseClient

  constructor(tx: DatabaseClient) {
    this.tx = tx
    this.internals = tx as unknown as TransactionInternals
    if (this.internals.nestedIndex !== 0 || !this.internals.session?.client) {
      throw new SourceFlowBindingDenied()
    }
    this.session = this.internals.session
    this.client = this.session.client
    this.query = this.client.query
    this.rollback = this.internals.rollback
    this.internals.rollback = () => {
      this.violated = true
      throw new SourceFlowBindingDenied()
    }
    this.guardedQuery = (...args) => {
      const text = queryText(args[0])
      // ORM использует один параметризованный DML statement. Управление ROOT,
      // SAVEPOINT и несколько statements нельзя передавать даже с catch.
      const normalized =
        typeof text === "string"
          ? text
              .replace(/\/\*[\s\S]*?\*\//g, " ")
              .replace(/--[^\n]*/g, " ")
              .trim()
          : ""
      if (!allowedStatement.test(normalized) || text.includes(";")) {
        this.violated = true
        return Promise.reject(new SourceFlowBindingDenied())
      }
      return Reflect.apply(this.query, this.client, args)
    }
    this.client.query = this.guardedQuery
  }

  async check(): Promise<void> {
    if (
      this.violated ||
      this.session.client !== this.client ||
      this.client.query !== this.guardedQuery ||
      (this.tx as unknown as TransactionInternals).session !== this.session ||
      this.internals.nestedIndex !== 0
    ) {
      throw new SourceFlowBindingDenied()
    }
    const result = await this.tx.execute<{ fingerprint: string }>(sql`
      SELECT pg_backend_pid()::text || ':' || pg_current_xact_id()::text
        || ':' || current_setting('search_path') AS fingerprint
    `)
    const current = result.rows[0]?.fingerprint
    if (
      !current ||
      (this.fingerprint !== undefined && current !== this.fingerprint)
    ) {
      throw new SourceFlowBindingDenied()
    }
    this.fingerprint = current
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    await this.check()
    try {
      return await operation()
    } finally {
      await this.check()
    }
  }

  close(): void {
    this.client.query = this.query
    if (this.rollback) {
      this.internals.rollback = this.rollback
    } else {
      this.internals.rollback = undefined
    }
  }
}

const blocked = (): DocumentBinding => ({
  kind: "blocked",
  code: "source_binding_unavailable",
})

class SupacrmSourceBindingService {
  private readonly options: {
    database: DatabaseClient
    authority?: SourceBindingAuthority
  }
  constructor(options: {
    database: DatabaseClient
    authority?: SourceBindingAuthority
  }) {
    this.options = options
  }

  private async unit<T>(
    work: (tx: DatabaseClient, guard: BindingUnitOfWork) => Promise<T>,
    tx?: DatabaseClient,
  ): Promise<T> {
    const run = async (actual: DatabaseClient) => {
      const guard = new BindingUnitOfWork(actual)
      try {
        return await guard.wait(() => work(actual, guard))
      } finally {
        guard.close()
      }
    }
    return await (tx ? run(tx) : this.options.database.transaction(run))
  }

  private async lockScope(tx: DatabaseClient, scope: SourceFlowScope) {
    const workspace = await tx
      .select({ id: workspaceModel.id })
      .from(workspaceModel)
      .where(eq(workspaceModel.id, scope.workspaceId))
      .for("share")
    if (workspace.length !== 1) {
      throw new SourceFlowBindingDenied()
    }
    const flow = await tx
      .select({ id: flowModel.id, workspaceId: flowModel.workspaceId })
      .from(flowModel)
      .where(
        and(
          eq(flowModel.id, scope.flowId),
          eq(flowModel.workspaceId, scope.workspaceId),
        ),
      )
      .for("update")
    if (flow.length !== 1) {
      throw new SourceFlowBindingDenied()
    }
  }

  private async read(
    tx: DatabaseClient,
    scope: SourceFlowScope,
  ): Promise<DocumentBinding> {
    // flowId без workspace predicate: повреждённая чужая привязка тоже DENY.
    const [row] = await tx
      .select()
      .from(supacrmSourceFlowBindingModel)
      .where(eq(supacrmSourceFlowBindingModel.flowId, scope.flowId))
    if (!row) {
      return { kind: "legacy", ...scope }
    }
    if (
      row.workspaceId !== scope.workspaceId ||
      row.bindingVersion !== 1 ||
      row.policy !== "source_only_v1" ||
      !digest.safeParse(row.actorDigest).success ||
      !digest.safeParse(row.policyDigest).success
    ) {
      throw new SourceFlowBindingDenied()
    }
    return Object.freeze({
      kind: "source",
      bindingId: row.id,
      ...scope,
      registryId: row.registryId,
      bindingVersion: 1,
      capabilities: sourceDocumentCapabilities,
    })
  }

  private async assertDedicatedFlow(
    tx: DatabaseClient,
    scope: SourceFlowScope,
  ): Promise<void> {
    const [flow] = await tx
      .select({ currentVersionId: flowModel.currentVersionId })
      .from(flowModel)
      .where(
        and(
          eq(flowModel.id, scope.flowId),
          eq(flowModel.workspaceId, scope.workspaceId),
        ),
      )
    const versions = await tx
      .select({
        id: flowVersionModel.id,
        workspaceId: flowVersionModel.workspaceId,
        isDraft: flowVersionModel.isDraft,
        nodes: flowVersionModel.nodes,
        edges: flowVersionModel.edges,
      })
      .from(flowVersionModel)
      .where(eq(flowVersionModel.flowId, scope.flowId))
      .limit(2)
    const runs = await tx
      .select({ id: flowRunModel.id })
      .from(flowRunModel)
      .where(eq(flowRunModel.flowId, scope.flowId))
      .limit(1)
    const draft = versions[0]
    if (
      !flow ||
      flow.currentVersionId !== null ||
      versions.length !== 1 ||
      !draft ||
      draft.workspaceId !== scope.workspaceId ||
      !draft.isDraft ||
      !Array.isArray(draft.nodes) ||
      draft.nodes.length !== 0 ||
      !Array.isArray(draft.edges) ||
      draft.edges.length !== 0 ||
      runs.length !== 0
    ) {
      throw new SourceFlowBindingDenied()
    }
  }

  async getDocumentBinding(
    input: SourceFlowScope,
    tx?: DatabaseClient,
  ): Promise<DocumentBinding> {
    try {
      const scope = flowScope.parse(input)
      return await this.unit(async (actual) => {
        await this.lockScope(actual, scope)
        return this.read(actual, scope)
      }, tx)
    } catch {
      return blocked()
    }
  }

  async bind(
    input: SourceBindingTarget,
    tx?: DatabaseClient,
  ): Promise<DocumentBinding> {
    const authority = this.options.authority
    if (!authority) {
      throw new SourceFlowBindingDenied()
    }
    const authorize = authority.authorizeBinding
    const target = Object.freeze(bindingTarget.parse(input))
    return await this.unit(async (tx, guard) => {
      await this.lockScope(tx, target)
      const previous = await this.read(tx, target)
      if (previous.kind === "legacy") {
        await this.assertDedicatedFlow(tx, target)
      }
      const admission = admissionSchema.parse(
        await guard.wait(() => authorize.call(authority, { target, tx })),
      )
      if (
        admission.target.workspaceId !== target.workspaceId ||
        admission.target.flowId !== target.flowId ||
        admission.target.registryId !== target.registryId ||
        this.options.authority !== authority ||
        authority.authorizeBinding !== authorize
      ) {
        throw new SourceFlowBindingDenied()
      }
      const existing = await this.read(tx, target)
      if (existing.kind === "source") {
        if (existing.registryId !== target.registryId) {
          throw new SourceFlowBindingDenied()
        }
        return existing
      }
      if (existing.kind !== "legacy") {
        throw new SourceFlowBindingDenied()
      }
      // Проверяем снова после verifier await: callback не меняет основание admission.
      await this.assertDedicatedFlow(tx, target)
      await tx.insert(supacrmSourceFlowBindingModel).values({
        workspaceId: target.workspaceId,
        flowId: target.flowId,
        registryId: target.registryId,
        bindingVersion: admission.bindingVersion,
        policy: admission.policy,
        authorizationId: admission.authorizationId,
        actorDigest: admission.actorDigest,
        policyDigest: admission.policyDigest,
      })
      return this.read(tx, target)
    }, tx)
  }

  async withLegacyFlow<T>(
    input: SourceFlowScope & { operation: LegacyFlowOperation },
    work: (tx: DatabaseClient) => Promise<T>,
    tx?: DatabaseClient,
  ): Promise<T> {
    const { operation, ...candidate } = input
    if (
      ![
        "updateDraft",
        "publish",
        "restore",
        "revert",
        "duplicate",
        "delete",
        "execute",
      ].includes(operation)
    ) {
      throw new SourceFlowBindingDenied()
    }
    const scope = flowScope.parse(candidate)
    return await this.unit(async (actual, guard) => {
      await this.lockScope(actual, scope)
      const binding = await this.read(actual, scope)
      if (binding.kind !== "legacy") {
        throw new SourceFlowBindingDenied()
      }
      return guard.wait(() => work(actual))
    }, tx)
  }
}

/** default authority отсутствует: браузерная авторизация не даёт право bind(). */
export function createSupacrmSourceBindingService(
  options: {
    database?: DatabaseClient
    authority?: SourceBindingAuthority
  } = {},
) {
  return new SupacrmSourceBindingService({
    ...options,
    database: options.database ?? db,
  })
}

export const supacrmSourceBindingService = createSupacrmSourceBindingService()
