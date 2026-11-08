import { type DatabaseClient, db, eq, sql } from "@chatbotx.io/database/client"
import { workspaceModel } from "@chatbotx.io/database/schema"
import { createId } from "@chatbotx.io/utils"
import { z } from "zod"
import { flowService } from "../flow/service"
import {
  createSupacrmSourceBindingService,
  type DocumentBinding,
  type SourceBindingAuthority,
  SourceFlowBindingDenied,
} from "./service"

const localIdPattern = /^[1-9][0-9]*$/
const inputSchema = z
  .object({
    workspaceId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine(
        (value) =>
          localIdPattern.test(value) &&
          BigInt(value) <= 9_223_372_036_854_775_807n,
      ),
    registryId: z.uuid(),
    name: z.string().trim().min(1).max(200),
  })
  .strict()

type ProvisionInput = z.infer<typeof inputSchema>
type SourceDocumentBinding = Extract<DocumentBinding, { kind: "source" }>

async function rootFingerprint(tx: DatabaseClient): Promise<string> {
  const result = await tx.execute<{ root: string }>(sql`
    SELECT pg_backend_pid()::text || ':' || pg_current_xact_id()::text AS root
  `)
  const root = result.rows[0]?.root
  if (!root) {
    throw new SourceFlowBindingDenied()
  }
  return root
}

/**
 * Единственный creator для нового source Flow: до commit ни Flow, ни его ID
 * не доступны legacy worker. Authority передаётся сервером, не из request body.
 */
export async function provisionSupacrmSourceFlow(
  input: ProvisionInput,
  ports: { authority?: SourceBindingAuthority; database?: DatabaseClient },
): Promise<SourceDocumentBinding> {
  const authority = ports?.authority
  if (!authority) {
    throw new SourceFlowBindingDenied()
  }
  const target = inputSchema.parse(input)
  const database = ports.database ?? db
  const bindings = createSupacrmSourceBindingService({ database, authority })
  return await database
    .transaction(async (tx) => {
      const root = await rootFingerprint(tx)
      // Тот же порядок блокировок, что у bind и legacy guard.
      const workspace = await tx
        .select({ id: workspaceModel.id })
        .from(workspaceModel)
        .where(eq(workspaceModel.id, target.workspaceId))
        .for("share")
      if (workspace.length !== 1) {
        throw new SourceFlowBindingDenied()
      }
      const flowId = await flowService.createFromImport({
        workspaceId: target.workspaceId,
        name: target.name,
        active: false,
        enableInInbox: false,
        startNodeId: createId(),
        nodes: [],
        edges: [],
        validatePublishable: false,
        tx,
      })
      if ((await rootFingerprint(tx)) !== root) {
        throw new SourceFlowBindingDenied()
      }
      const binding = await bindings.bind(
        {
          workspaceId: target.workspaceId,
          registryId: target.registryId,
          flowId,
        },
        tx,
      )
      if (binding.kind !== "source" || (await rootFingerprint(tx)) !== root) {
        throw new SourceFlowBindingDenied()
      }
      return binding
    })
    .catch(() => {
      // Ошибка verifier/SQL не раскрывает незакоммиченный ID или параметры запроса.
      throw new SourceFlowBindingDenied()
    })
}
