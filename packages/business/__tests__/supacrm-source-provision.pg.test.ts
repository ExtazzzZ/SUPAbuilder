import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { type DatabaseClient, sql } from "@chatbotx.io/database/client"
import { flowModel, workspaceModel } from "@chatbotx.io/database/schema"
import { drizzle } from "drizzle-orm/node-postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import { flowService } from "../src/flow/service"
import { provisionSupacrmSourceFlow } from "../src/supacrm-source-binding/provision"
import {
  createSupacrmSourceBindingService,
  type SourceBindingAuthority,
} from "../src/supacrm-source-binding/service"

// Сервис создания настоящий; изолированы только неиспользуемые side effects.
vi.mock("../src/base.service", () => ({ BaseService: class {} }))
vi.mock("../src/bot-field/service", () => ({ botFieldService: {} }))
vi.mock("../src/custom-field/service", () => ({ customFieldService: {} }))
vi.mock("../src/folder/service", () => ({ folderService: {} }))
vi.mock("../src/template/installed-resource.service", () => ({
  assertDeletable: vi.fn(),
}))
vi.mock("../src/messenger-welcome-message-flow/service", () => ({
  messengerWelcomeMessageFlowService: {},
}))
vi.mock("../src/flow-version", () => ({
  flowVersionService: {},
  assertFlowGraphPublishable: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  flowRepository: {},
  integrationWhatsappRepository: {},
  whatsappMessageTemplateRepository: {},
}))

const { Pool } = createRequire(
  new URL("../../database/package.json", import.meta.url),
)("pg")
const url = process.env.SOURCE_BINDING_TEST_DATABASE_URL
const input = {
  workspaceId: "1",
  registryId: "57e01413-9a3c-426f-940a-d490b78fb105",
  name: "Тестовый source Flow",
}

describe.skipIf(!url)("Атомарное создание source Flow в PostgreSQL", () => {
  const schema = `source_provision_${randomUUID().replaceAll("-", "")}`
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    max: 5,
  })
  const database = drizzle({
    client: pool,
    schema: { flowModel, workspaceModel },
  }) as unknown as DatabaseClient
  const authority: SourceBindingAuthority = {
    authorizeBinding: ({ target }) =>
      Promise.resolve({
        target: { ...target },
        bindingVersion: 1,
        policy: "source_only_v1",
        authorizationId: randomUUID(),
        actorDigest: "a".repeat(64),
        policyDigest: "b".repeat(64),
      }),
  }

  beforeAll(async () => {
    const parsed = new URL(url ?? "http://invalid")
    if (
      !(
        parsed.pathname.includes("test") &&
        ["127.0.0.1", "localhost"].includes(parsed.hostname)
      )
    ) {
      throw new Error("Нужна выделенная локальная тестовая PostgreSQL")
    }
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`
      CREATE TABLE "Workspace" (id bigint PRIMARY KEY);
      CREATE TABLE "Flow" (id bigint PRIMARY KEY, name text NOT NULL, active boolean NOT NULL,
        "enableInInbox" boolean NOT NULL, "currentVersionId" bigint, "draftVersionId" bigint,
        "workspaceId" bigint NOT NULL REFERENCES "Workspace"(id), "folderId" bigint,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE(id,"workspaceId"));
      CREATE TABLE "FlowVersion" (id bigint PRIMARY KEY, "workspaceId" bigint NOT NULL REFERENCES "Workspace"(id),
        "flowId" bigint NOT NULL REFERENCES "Flow"(id), "isDraft" boolean NOT NULL, "isLatest" boolean NOT NULL,
        nodes jsonb[] NOT NULL, edges jsonb[] NOT NULL, "startNodeId" bigint NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "FlowAnalyticsSession" (id bigint PRIMARY KEY, "flowId" bigint NOT NULL,
        "workspaceId" bigint NOT NULL, "deletedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "FlowRun" (id bigint PRIMARY KEY, "flowId" bigint NOT NULL REFERENCES "Flow"(id));
      CREATE TYPE "supacrmSourceFlowPolicy" AS ENUM ('source_only_v1');
      CREATE TABLE "SupacrmSourceFlowBinding" (id bigint PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "flowId" bigint NOT NULL UNIQUE, "workspaceId" bigint NOT NULL REFERENCES "Workspace"(id) ON DELETE RESTRICT,
        "registryId" uuid NOT NULL UNIQUE, "bindingVersion" integer NOT NULL CHECK("bindingVersion"=1),
        policy "supacrmSourceFlowPolicy" NOT NULL, "authorizationId" uuid NOT NULL UNIQUE,
        "actorDigest" text NOT NULL, "policyDigest" text NOT NULL,
        FOREIGN KEY("flowId","workspaceId") REFERENCES "Flow"(id,"workspaceId") ON DELETE RESTRICT);
    `)
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "Workspace", "Flow", "FlowVersion", "FlowAnalyticsSession", "FlowRun", "SupacrmSourceFlowBinding" CASCADE',
    )
    await pool.query('INSERT INTO "Workspace" VALUES(1)')
  })
  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })
  async function counts() {
    return (
      await pool.query(`SELECT
      (SELECT count(*)::int FROM "Flow") AS flows,
      (SELECT count(*)::int FROM "FlowVersion") AS drafts,
      (SELECT count(*)::int FROM "FlowAnalyticsSession") AS analytics,
      (SELECT count(*)::int FROM "SupacrmSourceFlowBinding") AS bindings`)
    ).rows[0]
  }
  const empty = { flows: 0, drafts: 0, analytics: 0, bindings: 0 }

  test("настоящий owning creator и bind не открывают observer legacy window", async () => {
    // Spy записывает аргументы и вызывает неизменённую настоящую реализацию.
    const creator = vi.spyOn(flowService, "createFromImport")
    let observedRoot: string | undefined
    const proof: SourceBindingAuthority = {
      authorizeBinding: vi.fn(async ({ target, tx }) => {
        observedRoot = (
          await tx.execute<{ root: string }>(
            sql`SELECT pg_backend_pid()::text || ':' || pg_current_xact_id()::text AS root`,
          )
        ).rows[0]?.root
        expect(await counts()).toEqual(empty)
        const local = await tx.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM "Flow"`,
        )
        expect(local.rows[0]?.count).toBe(1)
        expect(creator).toHaveBeenCalledWith(
          expect.objectContaining({
            tx,
            active: false,
            enableInInbox: false,
            nodes: [],
            edges: [],
            validatePublishable: false,
          }),
        )
        return authority.authorizeBinding({ target, tx })
      }),
    }
    const binding = await provisionSupacrmSourceFlow(input, {
      database,
      authority: proof,
    })
    expect(observedRoot).toBeTruthy()
    expect(binding).toMatchObject({
      kind: "source",
      registryId: input.registryId,
      workspaceId: "1",
    })
    expect(await counts()).toEqual({
      flows: 1,
      drafts: 1,
      analytics: 1,
      bindings: 1,
    })
    expect(
      (
        await pool.query(
          'SELECT active, "enableInInbox", "currentVersionId" FROM "Flow"',
        )
      ).rows[0],
    ).toEqual({ active: false, enableInInbox: false, currentVersionId: null })
    expect(
      (
        await createSupacrmSourceBindingService({
          database,
        }).getDocumentBinding({ workspaceId: "1", flowId: binding.flowId })
      ).kind,
    ).toBe("source")
    await expect(
      createSupacrmSourceBindingService({ database }).withLegacyFlow(
        { workspaceId: "1", flowId: binding.flowId, operation: "execute" },
        () => Promise.resolve(),
      ),
    ).rejects.toThrow()
    expect(Object.keys(binding)).not.toEqual(
      expect.arrayContaining([
        "actorDigest",
        "policyDigest",
        "authorizationId",
      ]),
    )
  })

  test("отсутствующий authority закрывает доступ до создания строк", async () => {
    const creator = vi.spyOn(flowService, "createFromImport")
    await expect(
      provisionSupacrmSourceFlow(input, { database }),
    ).rejects.toThrow("source_binding_denied")
    expect(creator).not.toHaveBeenCalled()
    expect(await counts()).toEqual(empty)
  })

  test.each([
    "denied",
    "wrong_tuple",
    "bool",
    "commit",
    "rollback",
    "nested",
  ])("%s откатывает Flow, draft, analytics и binding", async (variant) => {
    const proof: SourceBindingAuthority = {
      authorizeBinding: vi.fn(async ({ target, tx }) => {
        if (variant === "denied") {
          throw new Error("synthetic denied")
        }
        if (variant === "commit") {
          await tx.execute(sql`COMMIT`).catch(() => undefined)
        }
        if (variant === "rollback") {
          await tx.execute(sql`ROLLBACK`).catch(() => undefined)
        }
        if (variant === "nested") {
          await tx.transaction(() => Promise.resolve()).catch(() => undefined)
        }
        if (variant === "bool") {
          return true as never
        }
        const grant = await authority.authorizeBinding({ target, tx })
        return variant === "wrong_tuple"
          ? { ...grant, target: { ...grant.target, flowId: "99" } }
          : grant
      }),
    }
    await expect(
      provisionSupacrmSourceFlow(input, { database, authority: proof }),
    ).rejects.toThrow("source_binding_denied")
    expect(proof.authorizeBinding).toHaveBeenCalledTimes(1)
    expect(await counts()).toEqual(empty)
  })

  test.each([
    "flowId",
    "grant",
    "sourcePayload",
  ])("поле %s не принимается в запросе", async (field) => {
    await expect(
      provisionSupacrmSourceFlow({ ...input, [field]: "synthetic" } as never, {
        database,
        authority,
      }),
    ).rejects.toThrow()
    expect(await counts()).toEqual(empty)
  })

  test("занятый registry откатывает все строки второго нового Flow", async () => {
    const first = await provisionSupacrmSourceFlow(input, {
      database,
      authority,
    })
    await expect(
      provisionSupacrmSourceFlow(input, { database, authority }),
    ).rejects.toThrow("source_binding_denied")
    expect(await counts()).toEqual({
      flows: 1,
      drafts: 1,
      analytics: 1,
      bindings: 1,
    })
    expect((await pool.query('SELECT id::text FROM "Flow"')).rows).toEqual([
      { id: first.flowId },
    ])
  })

  test("изменение пустого графа verifier откатывает и новый Flow", async () => {
    const proof: SourceBindingAuthority = {
      authorizeBinding: async ({ target, tx }) => {
        await tx.execute(
          sql`UPDATE "FlowVersion" SET nodes=ARRAY['{"id":"synthetic"}'::jsonb] WHERE "flowId"=${target.flowId}`,
        )
        return authority.authorizeBinding({ target, tx })
      },
    }
    await expect(
      provisionSupacrmSourceFlow(input, { database, authority: proof }),
    ).rejects.toThrow("source_binding_denied")
    expect(await counts()).toEqual(empty)
  })
})
