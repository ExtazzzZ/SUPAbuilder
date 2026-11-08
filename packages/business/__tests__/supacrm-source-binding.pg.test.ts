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
import { supacrmSourceFlowBindingModel } from "../../database/src/schema/supacrm-source-flow-binding"
import {
  createSupacrmSourceBindingService,
  type SourceBindingAdmission,
} from "../src/supacrm-source-binding/service"

vi.mock("@chatbotx.io/database/schema", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/database/schema")>()),
  ...(await import("../../database/src/schema/supacrm-source-flow-binding")),
}))

// pg принадлежит database workspace; новые зависимости пакета не нужны.
const { Pool } = createRequire(
  new URL("../../database/package.json", import.meta.url),
)("pg")
const url = process.env.SOURCE_BINDING_TEST_DATABASE_URL
const scope = { workspaceId: "1", flowId: "2" }
const target = { ...scope, registryId: "57e01413-9a3c-426f-940a-d490b78fb105" }
const admission: SourceBindingAdmission = {
  target,
  authorizationId: "7cb787f9-0b93-4664-8715-70e20d29f75b",
  bindingVersion: 1,
  policy: "source_only_v1",
  actorDigest: "a".repeat(64),
  policyDigest: "b".repeat(64),
}

describe.skipIf(!url)("SUPAcrm binding: изолированная PostgreSQL", () => {
  const schema = `source_binding_${randomUUID().replaceAll("-", "")}`
  const app = schema
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    application_name: app,
    max: 5,
  })
  const database = drizzle({
    client: pool,
    schema: {
      flowModel,
      workspaceModel,
      supacrmSourceFlowBindingModel,
    },
  }) as unknown as DatabaseClient
  const service = () =>
    createSupacrmSourceBindingService({
      database,
      authority: { authorizeBinding: () => Promise.resolve(admission) },
    })

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
    // Минимальные реальные владельцы; имена/типы/FK соответствуют Drizzle.
    await pool.query(`
      CREATE TABLE "Workspace" (id bigint PRIMARY KEY);
      CREATE TABLE "Flow" (id bigint PRIMARY KEY, "currentVersionId" bigint, "workspaceId" bigint NOT NULL
        REFERENCES "Workspace"(id) ON DELETE CASCADE, UNIQUE(id,"workspaceId"));
      CREATE TABLE "FlowVersion" (id bigint PRIMARY KEY, "workspaceId" bigint NOT NULL,
        "flowId" bigint NOT NULL REFERENCES "Flow"(id), "isDraft" boolean NOT NULL,
        nodes jsonb[] NOT NULL, edges jsonb[] NOT NULL);
      CREATE TABLE "FlowRun" (id bigint PRIMARY KEY, "flowId" bigint NOT NULL REFERENCES "Flow"(id));
      CREATE TYPE "supacrmSourceFlowPolicy" AS ENUM ('source_only_v1');
      CREATE TABLE "SupacrmSourceFlowBinding" (
        id bigint PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "flowId" bigint NOT NULL UNIQUE, "workspaceId" bigint NOT NULL
          REFERENCES "Workspace"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        "registryId" uuid NOT NULL UNIQUE, "bindingVersion" integer NOT NULL CHECK("bindingVersion"=1),
        policy "supacrmSourceFlowPolicy" NOT NULL,
        "authorizationId" uuid NOT NULL UNIQUE,
        "actorDigest" text NOT NULL CHECK("actorDigest" ~ '^[0-9a-f]{64}$'),
        "policyDigest" text NOT NULL CHECK("policyDigest" ~ '^[0-9a-f]{64}$'),
        FOREIGN KEY("flowId","workspaceId") REFERENCES "Flow"(id,"workspaceId")
          ON DELETE RESTRICT ON UPDATE RESTRICT
      );
      CREATE INDEX ON "SupacrmSourceFlowBinding"("workspaceId");
      CREATE TABLE "Probe" (id integer PRIMARY KEY);
    `)
  })
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "Workspace", "Flow", "SupacrmSourceFlowBinding", "Probe" CASCADE',
    )
    await pool.query(
      "INSERT INTO \"Workspace\" VALUES(1),(9); INSERT INTO \"Flow\"(id,\"workspaceId\") VALUES(2,1),(8,9); INSERT INTO \"FlowVersion\" VALUES(4,1,2,true,'{}','{}'),(5,9,8,true,'{}','{}')",
    )
  })
  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  test("append-only tuple, fresh replay, DB FK, registry uniqueness, no protected browser fields", async () => {
    const s = service()
    expect((await s.getDocumentBinding(scope)).kind).toBe("legacy")
    const saved = await s.bind(target)
    expect(saved.kind).toBe("source")
    expect(await s.bind(target)).toEqual(saved)
    expect(JSON.stringify(saved)).not.toContain("actorDigest")
    await expect(
      s.bind({ ...target, registryId: randomUUID() }),
    ).rejects.toThrow()
    await expect(s.bind({ ...target, workspaceId: "9" })).rejects.toThrow()
    const another = createSupacrmSourceBindingService({
      database,
      authority: {
        authorizeBinding: ({ target: requested }) =>
          Promise.resolve({
            ...admission,
            target: requested,
            authorizationId: randomUUID(),
          }),
      },
    })
    await expect(
      another.bind({ ...target, workspaceId: "9", flowId: "8" }),
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "SupacrmSourceFlowBinding"',
        )
      ).rows[0].count,
    ).toBe(1)
    await expect(
      pool.query('UPDATE "SupacrmSourceFlowBinding" SET "workspaceId"=9'),
    ).rejects.toThrow()
    await pool.query('DELETE FROM "FlowVersion" WHERE "flowId"=2')
    await expect(pool.query('DELETE FROM "Flow" WHERE id=2')).rejects.toThrow()
    await expect(
      pool.query('DELETE FROM "Workspace" WHERE id=1'),
    ).rejects.toThrow()
  })

  test.each([
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT sp",
    "/*prefix*/ COMMIT",
    "SELECT 1; COMMIT",
    "SELECT '--'; COMMIT",
  ])("callback %s не фиксирует dirty prefix", async (command) => {
    const s = createSupacrmSourceBindingService({
      database,
      authority: {
        authorizeBinding: async ({ tx }) => {
          await tx.execute(sql`INSERT INTO "Probe" VALUES(1)`)
          await tx.execute(sql.raw(command)).catch(() => undefined)
          return admission
        },
      },
    })
    await expect(s.bind(target)).rejects.toThrow()
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM "Probe"')).rows[0]
        .count,
    ).toBe(0)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "SupacrmSourceFlowBinding"',
        )
      ).rows[0].count,
    ).toBe(0)
    // Наблюдатель клиентского query обязательно снимается и не отравляет Pool.
    expect((await service().getDocumentBinding(scope)).kind).toBe("legacy")
  })

  test("callback cannot use Drizzle nested transaction or rollback method", async () => {
    for (const mutate of [
      (tx: DatabaseClient) => tx.transaction(() => Promise.resolve()),
      (tx: DatabaseClient) => {
        const actual = tx as unknown as { rollback: () => never }
        return Promise.resolve(actual.rollback())
      },
    ]) {
      const s = createSupacrmSourceBindingService({
        database,
        authority: {
          authorizeBinding: async ({ tx }) => {
            await tx.execute(sql`INSERT INTO "Probe" VALUES(1)`)
            await mutate(tx)
            return admission
          },
        },
      })
      await expect(s.bind(target)).rejects.toThrow()
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM "Probe"')).rows[0]
          .count,
      ).toBe(0)
    }
  })

  test.each([
    "published",
    "history",
    "nodes",
    "edges",
    "runs",
    "noDraft",
  ])("actual dedicated precondition denies %s", async (variant) => {
    if (variant === "published") {
      await pool.query('UPDATE "Flow" SET "currentVersionId"=4 WHERE id=2')
    }
    if (variant === "history") {
      await pool.query('UPDATE "FlowVersion" SET "isDraft"=false WHERE id=4')
    }
    if (variant === "nodes") {
      await pool.query(
        'UPDATE "FlowVersion" SET nodes=ARRAY[\'{"id":"step"}\'::jsonb] WHERE id=4',
      )
    }
    if (variant === "edges") {
      await pool.query(
        'UPDATE "FlowVersion" SET edges=ARRAY[\'{"id":"edge"}\'::jsonb] WHERE id=4',
      )
    }
    if (variant === "runs") {
      await pool.query('INSERT INTO "FlowRun" VALUES(7,2)')
    }
    if (variant === "noDraft") {
      await pool.query('DELETE FROM "FlowVersion" WHERE id=4')
    }
    await expect(service().bind(target)).rejects.toThrow()
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "SupacrmSourceFlowBinding"',
        )
      ).rows[0].count,
    ).toBe(0)
  })

  test("verifier не может изменить empty admission внутри await", async () => {
    const s = createSupacrmSourceBindingService({
      database,
      authority: {
        authorizeBinding: async ({ tx }) => {
          await tx.execute(
            sql`UPDATE "FlowVersion" SET nodes=ARRAY['{"id":"step"}'::jsonb] WHERE id=4`,
          )
          return admission
        },
      },
    })
    await expect(s.bind(target)).rejects.toThrow()
    expect(
      (
        await pool.query(
          'SELECT cardinality(nodes)::int AS count FROM "FlowVersion" WHERE id=4',
        )
      ).rows[0].count,
    ).toBe(0)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "SupacrmSourceFlowBinding"',
        )
      ).rows[0].count,
    ).toBe(0)
  })

  test("binding failure и отсутствующий Flow никогда не legacy", async () => {
    const s = service()
    expect((await s.getDocumentBinding({ ...scope, flowId: "99" })).kind).toBe(
      "blocked",
    )
    expect(
      (await s.getDocumentBinding({ ...scope, workspaceId: "9" })).kind,
    ).toBe("blocked")
    await pool.query(
      'ALTER TABLE "SupacrmSourceFlowBinding" RENAME TO "TemporarilyUnavailable"',
    )
    try {
      expect((await s.getDocumentBinding(scope)).kind).toBe("blocked")
    } finally {
      await pool.query(
        'ALTER TABLE "TemporarilyUnavailable" RENAME TO "SupacrmSourceFlowBinding"',
      )
    }
  })

  test("legacy mutation и bind сериализованы одним Flow lock", async () => {
    const s = service()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const legacy = s.withLegacyFlow(
      { ...scope, operation: "updateDraft" },
      async (tx) => {
        await tx.execute(sql`INSERT INTO "Probe" VALUES(1)`)
        entered()
        await held
      },
    )
    await ready
    const binding = s.bind(target)
    try {
      let waiting = false
      for (let i = 0; i < 100; i++) {
        const state = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [app],
        )
        if (state.rowCount) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
    } finally {
      release()
    }
    await legacy
    expect((await binding).kind).toBe("source")
    const work = vi.fn(() => Promise.resolve())
    await expect(
      s.withLegacyFlow({ ...scope, operation: "execute" }, work),
    ).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })
})
