// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const FIXTURE_AUTH_HEADER = "Bearer synthetic-workspace-token"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  session: vi.fn(),
  member: vi.fn(),
  access: vi.fn(),
  token: vi.fn(),
}))
vi.mock("../../../packages/business/src/flow", () => ({ flowService: {} }))
vi.mock("../../../packages/business/src/flow-version", () => ({
  flowVersionService: {},
}))
vi.mock("../../../packages/business/src/net/ssrf-guard", () => ({
  checkSsrfSafety: vi.fn(),
}))
vi.mock("@chatbotx.io/business", async () => {
  const { fulfillmentStatusSchema } = await import(
    "../../../packages/business/src/supacrm-fulfillment"
  )
  return {
    fulfillmentStatusSchema,
    fulfillmentStatusService: { read: mocks.read },
    workspaceMemberService: { findMembership: mocks.member },
    resolveWorkspaceAccess: mocks.access,
    workspaceApiTokenService: { findWorkspaceByTokenHash: mocks.token },
    isWorkspaceScheduledForDeletion: () => false,
    userQuotaService: {},
    quotaEnforcementService: {},
  }
})
vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: mocks.session } },
}))
vi.mock("@chatbotx.io/business/audit", () => ({
  withAuditContext: (_: unknown, fn: () => unknown) => fn(),
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({
  assertApiNotRateLimited: vi.fn(),
}))
vi.mock("@/lib/log", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/env", () => ({ isCloud: () => false }))
const { call } = await import("@orpc/server")
const { privateFulfillmentStatus, publicFulfillmentStatus } = await import(
  "../src/features/flows/api/fulfillment-status"
)
const ref = "123e4567-e89b-42d3-a456-426614174000"
const input = { flowId: "30", fulfillmentRef: ref }
const dto = {
  fulfillmentRef: ref,
  purchaseStatus: "completed",
  deliveryStatus: "prepared",
  nativeStatus: "waiting",
  parts: [
    { key: "author_instruction", status: "sent" },
    { key: "apple_code_reference", status: "prepared" },
  ],
}
const context = () => ({
  headers: new Headers({ Authorization: FIXTURE_AUTH_HEADER }),
  resHeaders: new Headers(),
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ session: {}, user: { id: "user-1" } })
  mocks.member.mockResolvedValue({ role: "admin" })
  mocks.access.mockResolvedValue({
    workspace: { id: "10", ownerId: "owner" },
    member: { permissions: {} },
  })
  mocks.token.mockResolvedValue({
    workspace: { id: "10", ownerId: "owner" },
    apiToken: { id: "token", permission: "read_only", scopes: ["automation"] },
  })
  mocks.read.mockResolvedValue(dto)
})
test("actual UI/public procedures return the same strict safe DTO with private no-store", async () => {
  const ui = context(),
    api = context()
  expect(
    await call(
      privateFulfillmentStatus,
      { ...input, workspaceId: "10" },
      { context: ui },
    ),
  ).toEqual(dto)
  expect(await call(publicFulfillmentStatus, input, { context: api })).toEqual(
    dto,
  )
  expect(mocks.read.mock.calls.map((args) => args[0])).toEqual([
    { ...input, workspaceId: "10" },
    { ...input, workspaceId: "10" },
  ])
  for (const ctx of [ui, api]) {
    expect(ctx.resHeaders.get("Cache-Control")).toBe("private, no-store")
  }
  expect(privateFulfillmentStatus["~orpc"].route.method).toBe("GET")
})
test("real session/workspace and public automation scope gates reject before status read", async () => {
  mocks.access.mockResolvedValue(null)
  await expect(
    call(
      privateFulfillmentStatus,
      { ...input, workspaceId: "999" },
      { context: context() },
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  mocks.session.mockResolvedValue(null)
  await expect(
    call(
      privateFulfillmentStatus,
      { ...input, workspaceId: "10" },
      { context: context() },
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  mocks.token.mockResolvedValue({
    workspace: { id: "10", ownerId: "owner" },
    apiToken: { id: "token", permission: "read_only", scopes: ["contacts"] },
  })
  await expect(
    call(publicFulfillmentStatus, input, { context: context() }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(mocks.read).not.toHaveBeenCalled()
})
test("owner refusal is no-store and unexpected secret fields cannot become UI/API DTO", async () => {
  mocks.read.mockRejectedValue(new Error("fulfillment_status_scope_invalid"))
  const ctx = context()
  await expect(
    call(
      privateFulfillmentStatus,
      { ...input, workspaceId: "10" },
      { context: ctx },
    ),
  ).rejects.toThrow()
  expect(ctx.resHeaders.get("Cache-Control")).toBe("private, no-store")
  mocks.read.mockResolvedValue({ ...dto, secret: "PRIVATE_SENTINEL" })
  await expect(
    call(publicFulfillmentStatus, input, { context: context() }),
  ).rejects.toThrow()
})

test.each([
  "refunded",
  "rejected",
])("UI and agent DTO retain provider purchase %s separately from native review", async (purchaseStatus) => {
  const terminal = { ...dto, purchaseStatus, nativeStatus: "review" }
  mocks.read.mockResolvedValue(terminal)
  expect(
    await call(
      privateFulfillmentStatus,
      { ...input, workspaceId: "10" },
      { context: context() },
    ),
  ).toEqual(terminal)
  expect(
    await call(publicFulfillmentStatus, input, { context: context() }),
  ).toEqual(terminal)
})
