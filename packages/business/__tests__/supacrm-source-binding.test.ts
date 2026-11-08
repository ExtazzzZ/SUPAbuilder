import type { DatabaseClient } from "@chatbotx.io/database/client"
import {
  flowModel,
  flowRunModel,
  flowVersionModel,
  workspaceModel,
} from "@chatbotx.io/database/schema"
import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, test, vi } from "vitest"
import { supacrmSourceFlowBindingModel } from "../../database/src/schema/supacrm-source-flow-binding"
import {
  createSupacrmSourceBindingService,
  type SourceBindingAdmission,
  SourceFlowBindingDenied,
} from "../src/supacrm-source-binding/service"

vi.mock("@chatbotx.io/database/schema", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/database/schema")>()),
  ...(await import("../../database/src/schema/supacrm-source-flow-binding")),
}))

const target = {
  workspaceId: "1",
  flowId: "2",
  registryId: "57e01413-9a3c-426f-940a-d490b78fb105",
}
const admission: SourceBindingAdmission = {
  target,
  bindingVersion: 1,
  policy: "source_only_v1",
  authorizationId: "7cb787f9-0b93-4664-8715-70e20d29f75b",
  actorDigest: "a".repeat(64),
  policyDigest: "b".repeat(64),
}

function fixture() {
  let row: Record<string, unknown> | undefined
  let workspace = true
  let flow = true
  let brokenRead = false
  let fingerprint = "backend:root:public"
  let currentVersionId: string | null = null
  let versions = [
    {
      id: "4",
      workspaceId: "1",
      isDraft: true,
      nodes: [] as unknown[],
      edges: [] as unknown[],
    },
  ]
  let runs: { id: string }[] = []
  const events: string[] = []
  const query = vi.fn((_config?: unknown) => Promise.resolve({ rows: [] }))
  const client = { query }
  const actual = {
    nestedIndex: 0,
    session: { client },
    execute: vi.fn(async () => ({ rows: [{ fingerprint }] })),
    select: vi.fn(() => ({
      from(table: unknown) {
        const load = () => {
          if (table === workspaceModel) {
            return workspace ? [{ id: "1" }] : []
          }
          if (table === flowModel) {
            return flow ? [{ id: "2", workspaceId: "1", currentVersionId }] : []
          }
          if (table === flowVersionModel) {
            return versions
          }
          if (table === flowRunModel) {
            return runs
          }
          if (brokenRead) {
            throw new Error("synthetic database detail")
          }
          return row ? [row] : []
        }
        return {
          where: () => ({
            limit: () => Promise.resolve(load()),
            for: (lock: string) => {
              events.push(
                `${table === workspaceModel ? "workspace" : "flow"}:${lock}`,
              )
              return Promise.resolve(load())
            },
            // biome-ignore lint/suspicious/noThenProperty: Drizzle builder является thenable.
            then: (
              resolve: (value: unknown) => unknown,
              reject: (error: unknown) => unknown,
            ) => Promise.resolve().then(load).then(resolve, reject),
          }),
        }
      },
    })),
    insert: vi.fn(() => ({
      values: (value: Record<string, unknown>) => {
        events.push("insert")
        row = { id: "3", ...value }
        return Promise.resolve()
      },
    })),
  }
  const tx = actual as unknown as DatabaseClient
  const database = {
    transaction: async (work: (value: DatabaseClient) => Promise<unknown>) => {
      const previous = row
      try {
        return await work(tx)
      } catch (error) {
        row = previous
        throw error
      }
    },
  } as unknown as DatabaseClient
  return {
    tx,
    actual,
    client,
    query,
    database,
    events,
    state: {
      get row() {
        return row
      },
      set row(value: Record<string, unknown> | undefined) {
        row = value
      },
      set workspace(value: boolean) {
        workspace = value
      },
      set flow(value: boolean) {
        flow = value
      },
      set brokenRead(value: boolean) {
        brokenRead = value
      },
      set fingerprint(value: string) {
        fingerprint = value
      },
      set currentVersionId(value: string | null) {
        currentVersionId = value
      },
      set versions(value: typeof versions) {
        versions = value
      },
      set runs(value: typeof runs) {
        runs = value
      },
    },
  }
}

describe("SUPAcrm owning Flow binding", () => {
  test("schema имеет composite FK, уникальный Flow и registry, индексы и version CHECK", () => {
    const schema = getTableConfig(supacrmSourceFlowBindingModel)
    expect(
      schema.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name)),
    ).toEqual(
      expect.arrayContaining([["workspaceId"], ["flowId", "workspaceId"]]),
    )
    expect(schema.indexes.filter((idx) => idx.config.unique)).toHaveLength(3)
    expect(schema.checks).toHaveLength(3)
  })

  test("legacy возможен только после реальных workspace/Flow locks", async () => {
    const f = fixture()
    const result = await createSupacrmSourceBindingService(
      f,
    ).getDocumentBinding({ workspaceId: "1", flowId: "2" })
    expect(result.kind).toBe("legacy")
    expect(f.events).toEqual(["workspace:share", "flow:update"])
    expect(f.client.query).toBe(f.query)
  })

  test.each([
    "workspace",
    "flow",
    "brokenRead",
  ] as const)("%s failure закрывает доступ, не legacy", async (key) => {
    const f = fixture()
    if (key === "brokenRead") {
      f.state.brokenRead = true
    } else {
      f.state[key] = false
    }
    expect(
      await createSupacrmSourceBindingService(f).getDocumentBinding({
        workspaceId: "1",
        flowId: "2",
      }),
    ).toEqual({ kind: "blocked", code: "source_binding_unavailable" })
  })

  test("bind без authority запрещён", async () => {
    const f = fixture()
    await expect(
      createSupacrmSourceBindingService(f).bind(target),
    ).rejects.toBeInstanceOf(SourceFlowBindingDenied)
    expect(f.events).toEqual([])
  })

  test.each([
    "published",
    "history",
    "nodes",
    "edges",
    "runs",
    "noDraft",
  ])("dedicated admission denies %s", async (variant) => {
    const f = fixture()
    if (variant === "published") {
      f.state.currentVersionId = "4"
    }
    if (variant === "history") {
      f.state.versions = [
        { id: "4", workspaceId: "1", isDraft: false, nodes: [], edges: [] },
      ]
    }
    if (variant === "nodes") {
      f.state.versions = [
        {
          id: "4",
          workspaceId: "1",
          isDraft: true,
          nodes: [{ id: "step" }],
          edges: [],
        },
      ]
    }
    if (variant === "edges") {
      f.state.versions = [
        { id: "4", workspaceId: "1", isDraft: true, nodes: [], edges: [{}] },
      ]
    }
    if (variant === "runs") {
      f.state.runs = [{ id: "7" }]
    }
    if (variant === "noDraft") {
      f.state.versions = []
    }
    const authority = {
      authorizeBinding: vi.fn(() => Promise.resolve(admission)),
    }
    await expect(
      createSupacrmSourceBindingService({ ...f, authority }).bind(target),
    ).rejects.toThrow()
    expect(authority.authorizeBinding).not.toHaveBeenCalled()
    expect(f.state.row).toBeUndefined()
  })

  test("fresh typed admission после locks; replay не меняет provenance", async () => {
    const f = fixture()
    const authorizeBinding = vi.fn(({ tx, target: locked }) => {
      expect(tx).toBe(f.tx)
      expect(locked).toEqual(target)
      expect(Object.isFrozen(locked)).toBe(true)
      expect(f.events.slice(0, 2)).toEqual(["workspace:share", "flow:update"])
      return Promise.resolve(admission)
    })
    const service = createSupacrmSourceBindingService({
      ...f,
      authority: { authorizeBinding },
    })
    const source = await service.bind(target)
    expect(source).toMatchObject({
      kind: "source",
      registryId: target.registryId,
      bindingVersion: 1,
    })
    const saved = f.state.row
    expect(await service.bind(target)).toEqual(source)
    expect(f.state.row).toBe(saved)
    expect(authorizeBinding).toHaveBeenCalledTimes(2)
    expect(f.actual.insert).toHaveBeenCalledTimes(1)
    expect(Object.keys(source)).not.toContain("actorDigest")
  })

  test.each([
    true,
    { ...admission, target: { ...target, flowId: "9" } },
  ])("bool или чужой tuple не admission", async (proof) => {
    const f = fixture()
    const authority = { authorizeBinding: vi.fn(async () => proof) }
    await expect(
      createSupacrmSourceBindingService({
        ...f,
        authority: authority as unknown as {
          authorizeBinding: () => Promise<SourceBindingAdmission>
        },
      }).bind(target),
    ).rejects.toThrow()
    expect(f.state.row).toBeUndefined()
  })

  test.each([
    "commit",
    "rollback",
    "savepoint sp",
    "/*hidden*/ COMMIT",
    "select 1; COMMIT",
    "SELECT '--'; COMMIT",
  ])("callback topology %s запрещена до SQL даже при catch", async (command) => {
    const f = fixture()
    const authority = {
      authorizeBinding: async () => {
        await f.client.query({ text: command } as never).catch(() => undefined)
        return admission
      },
    }
    await expect(
      createSupacrmSourceBindingService({ ...f, authority }).bind(target),
    ).rejects.toThrow()
    expect(f.query).not.toHaveBeenCalled()
    expect(f.state.row).toBeUndefined()
    expect(f.client.query).toBe(f.query)
  })

  test("смена физического ROOT после await не допускает insert", async () => {
    const f = fixture()
    const authority = {
      authorizeBinding: () => {
        f.state.fingerprint = "backend:another-root:public"
        return Promise.resolve(admission)
      },
    }
    await expect(
      createSupacrmSourceBindingService({ ...f, authority }).bind(target),
    ).rejects.toThrow()
    expect(f.state.row).toBeUndefined()
  })

  test("пойманный tx.rollback() не позволяет сохранить binding", async () => {
    const f = fixture()
    const authority = {
      authorizeBinding: () => {
        try {
          ;(f.tx as unknown as { rollback: () => never }).rollback()
        } catch {
          /* Callback не может скрыть попытку rollback. */
        }
        return Promise.resolve(admission)
      },
    }
    await expect(
      createSupacrmSourceBindingService({ ...f, authority }).bind(target),
    ).rejects.toThrow()
    expect(f.state.row).toBeUndefined()
  })

  test.each([
    "updateDraft",
    "publish",
    "restore",
    "revert",
    "duplicate",
    "delete",
    "execute",
  ] as const)("source bound %s никогда не вызывает legacy callback", async (operation) => {
    const f = fixture()
    f.state.row = {
      id: "3",
      ...target,
      bindingVersion: 1,
      policy: "source_only_v1",
      actorDigest: admission.actorDigest,
      policyDigest: admission.policyDigest,
    }
    const work = vi.fn()
    await expect(
      createSupacrmSourceBindingService(f).withLegacyFlow(
        { ...targetWithoutRegistry(), operation },
        work,
      ),
    ).rejects.toBeInstanceOf(SourceFlowBindingDenied)
    expect(work).not.toHaveBeenCalled()
  })

  test("legacy work получает фактический tx; его COMMIT тоже запрещён", async () => {
    const f = fixture()
    const service = createSupacrmSourceBindingService(f)
    await expect(
      service.withLegacyFlow(
        { ...targetWithoutRegistry(), operation: "publish" },
        async (tx) => {
          expect(tx).toBe(f.tx)
          await f.client.query({ text: "COMMIT" } as never)
        },
      ),
    ).rejects.toThrow()
    expect(f.client.query).toBe(f.query)
  })
})

function targetWithoutRegistry() {
  return { workspaceId: target.workspaceId, flowId: target.flowId }
}
