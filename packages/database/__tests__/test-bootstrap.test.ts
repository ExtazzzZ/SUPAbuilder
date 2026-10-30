import { createHash, randomBytes } from "node:crypto"
import { verifyPassword } from "better-auth/crypto"
import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  existing: false,
  writes: [] as { table: unknown; value: Record<string, unknown> }[],
  transaction: vi.fn(),
  execute: vi.fn(),
}))
vi.mock("../src/client", () => ({
  sql: vi.fn(),
  db: {
    transaction: state.transaction,
  },
}))

import {
  accountModel,
  workspaceApiTokenModel,
  workspaceMemberModel,
} from "../src/schema"
import { bootstrapTestWorkspace } from "../src/seed/test-bootstrap"

const environment = () => ({
  RUN_TEST_BOOTSTRAP: "true",
  TEST_ADMIN_EMAIL: "test@example.invalid",
  TEST_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
  TEST_WORKSPACE_TOKEN: `cbx_ws_${randomBytes(32).toString("base64url")}`,
})

beforeEach(() => {
  state.existing = false
  state.writes = []
  state.transaction.mockReset().mockImplementation(async (callback) => {
    const writes: typeof state.writes = []
    const result = await callback({
      execute: state.execute,
      query: {
        userModel: {
          findFirst: () => (state.existing ? { id: "1" } : undefined),
        },
      },
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          writes.push({ table, value })
        },
      }),
    })
    state.writes.push(...writes)
    return result
  })
})

test("does nothing unless explicitly enabled", async () => {
  expect(await bootstrapTestWorkspace({})).toEqual({ created: false })
  expect(state.transaction).not.toHaveBeenCalled()
})

test("existing installation never resets credentials even if env is removed", async () => {
  state.existing = true
  expect(await bootstrapTestWorkspace({ RUN_TEST_BOOTSTRAP: "true" })).toEqual({
    created: false,
  })
  expect(state.writes).toHaveLength(0)
})

test("invalid credentials leave database empty and are absent from errors", async () => {
  const env = environment()
  env.TEST_WORKSPACE_TOKEN = "invalid-secret"
  await expect(bootstrapTestWorkspace(env)).rejects.toThrow(
    "Invalid TEST bootstrap environment",
  )
  expect(state.writes).toHaveLength(0)
})

test("creates an owner and compatible credentials in one transaction", async () => {
  const env = environment()
  const result = await bootstrapTestWorkspace(env)
  expect(result.created).toBe(true)
  expect(state.transaction).toHaveBeenCalledTimes(1)
  expect(state.writes).toHaveLength(5)
  const account = state.writes.find((row) => row.table === accountModel)?.value
  expect(
    await verifyPassword({
      hash: account?.password as string,
      password: env.TEST_ADMIN_PASSWORD,
    }),
  ).toBe(true)
  const token = state.writes.find(
    (row) => row.table === workspaceApiTokenModel,
  )?.value
  expect(token).toMatchObject({
    workspaceId: result.workspaceId,
    permission: "full",
    isDefault: false,
    tokenHash: createHash("sha256")
      .update(env.TEST_WORKSPACE_TOKEN)
      .digest("hex"),
  })
  expect(JSON.stringify(state.writes.map((row) => row.value))).not.toContain(
    env.TEST_ADMIN_PASSWORD,
  )
  expect(JSON.stringify(state.writes.map((row) => row.value))).not.toContain(
    env.TEST_WORKSPACE_TOKEN,
  )
  expect(
    state.writes.find((row) => row.table === workspaceMemberModel)?.value,
  ).toMatchObject({
    role: "owner",
    workspaceId: result.workspaceId,
    notificationChannels: { browser: true },
    notificationTypes: { notifyAdmin: false },
  })
})
