// @vitest-environment node
/** Targeted server-adapter tests: mocked external ports, без SSR DB/browser claims. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const p = vi.hoisted(() => ({
  columns: {
    accountId: "column.accountId",
    userId: "column.userId",
    providerId: "column.providerId",
    tenantId: "column.tenantId",
  },
  root: "canonical-root-tenant",
  config: vi.fn(),
  current: vi.fn(),
  crm: vi.fn(),
  permission: vi.fn(),
  binding: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@chatbotx.io/auth/supalogin", () => ({
  getSupaLoginConfig: p.config,
  checkCrmAccess: p.crm,
}))
vi.mock("@chatbotx.io/business/supacrm-source-binding", () => ({
  supacrmSourceBindingService: { getDocumentBinding: p.binding },
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: { select: p.select },
  eq: p.eq,
  and: p.and,
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  accountModel: p.columns,
  ROOT_TENANT_ID: p.root,
}))
vi.mock("@/lib/auth/require-workspace-permission", () => ({
  requireWorkspacePermission: p.permission,
}))
vi.mock("@/lib/auth/utils", () => ({
  getCurrentUserAndTargetWorkspace: p.current,
}))

// Actual own exports/authorizer; hasWorkspacePermission is also the real predicate.
import {
  authorizeNativeSourceRequest,
  resolveNativeSourceDocument,
} from "../src/lib/source-authoring-native/server"
import { forwardNativeSource } from "../src/lib/source-authoring-native/transport"

const target = { workspaceId: "100", flowId: "200" }
const issuer = "https://identity.example.test"
const subject = "canonical-oidc-subject"
const config = { issuer, workspaceId: target.workspaceId }
const source = {
  kind: "source",
  bindingId: "saved-local-binding",
  ...target,
  registryId: "11111111-1111-4111-8111-111111111111",
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
}
const blocked = { kind: "blocked", code: "source_binding_unavailable" }
function current() {
  return {
    user: { id: "betterauth-local-user", email: "local@example.test" },
    isSupportSession: false,
    targetWorkspaceMember: { role: "member", permissions: { flows: true } },
  }
}
type Row = {
  accountId: string
  userId: string
  providerId: string
  tenantId: string
}
let rows: Row[]
function account(overrides: Partial<Row> = {}): Row {
  return {
    accountId: `${issuer}|${subject}`,
    userId: current().user.id,
    providerId: "supalogin",
    tenantId: p.root,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request")
    }),
  )
  p.config.mockReturnValue(config)
  p.current.mockResolvedValue(current())
  p.permission.mockResolvedValue(undefined)
  p.crm.mockResolvedValue({ allowed: true, role: "member" })
  p.binding.mockResolvedValue(source)
  p.eq.mockImplementation((column, value) => ({ column, value }))
  p.and.mockImplementation((...conditions) => conditions)
  rows = [account()]
  p.select.mockReturnValue({ from: p.from })
  p.from.mockReturnValue({ where: p.where })
  p.where.mockImplementation(
    (conditions: { column: string; value: unknown }[]) => ({
      limit: (limit: number) => {
        p.limit(limit)
        return Promise.resolve(
          rows
            .filter((row) =>
              conditions.every(
                ({ column, value }) =>
                  row[column.slice("column.".length) as keyof Row] === value,
              ),
            )
            .slice(0, limit)
            .map((row) => ({ accountId: row.accountId })),
        )
      },
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe("actual native server adapter: canonical account and fresh authority", () => {
  test("queries unique ROOT/provider/current-user account and emits issuer-bound subject", async () => {
    // Missing ANY predicate makes this fixture ambiguous, so actor cannot resolve.
    rows.push(
      account({ userId: "foreign-user" }),
      account({ providerId: "credential" }),
      account({ tenantId: "foreign-tenant" }),
    )
    const result = await authorizeNativeSourceRequest(target)
    expect(result?.actor).toBe(subject)
    expect(result?.actor).not.toBe(current().user.id)
    expect(result?.actor).not.toBe(current().user.email)
    expect(p.select).toHaveBeenCalledWith({ accountId: p.columns.accountId })
    expect(p.from).toHaveBeenCalledWith(p.columns)
    expect(p.where).toHaveBeenCalledWith([
      { column: p.columns.userId, value: current().user.id },
      { column: p.columns.providerId, value: "supalogin" },
      { column: p.columns.tenantId, value: p.root },
    ])
    expect(p.limit).toHaveBeenCalledWith(2)
    expect(p.permission).toHaveBeenCalledWith("100", "flows")
    expect(p.crm).toHaveBeenCalledWith(config, {
      userId: subject,
      email: current().user.email,
    })
    expect(p.binding).toHaveBeenCalledWith(target)
  })
  test.each(
    [
      [],
      [account(), account()],
      [account({ accountId: "betterauth-local-user" })],
      [account({ accountId: "local@example.test" })],
      [account({ accountId: `https://foreign.example.test|${subject}` })],
      [account({ accountId: `${issuer}.attacker|${subject}` })],
      [account({ accountId: `${issuer}|` })],
      [account({ tenantId: "foreign-tenant" })],
      [account({ providerId: "credential" })],
      [account({ userId: "foreign-user" })],
    ].map((accounts: Row[]) => ({ accounts })),
  )("missing/ambiguous/noncanonical account denied %#", async ({
    accounts,
  }) => {
    rows = accounts
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(p.crm).not.toHaveBeenCalled()
    expect(p.binding).not.toHaveBeenCalled()
  })
  test.each([
    undefined,
    false,
    "true",
    1,
  ])("actual flows predicate denies %s", async (flows) => {
    p.current.mockResolvedValue({
      ...current(),
      targetWorkspaceMember: { role: "member", permissions: { flows } },
    })
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(p.select).not.toHaveBeenCalled()
    expect(p.binding).not.toHaveBeenCalled()
  })
  test("missing config or foreign workspace denies before auth lookup", async () => {
    p.config.mockReturnValue(null)
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    p.config.mockReturnValue({ ...config, workspaceId: "999" })
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(p.permission).not.toHaveBeenCalled()
    expect(p.current).not.toHaveBeenCalled()
  })
  test("support and missing session denied even if permission guard returned", async () => {
    p.current.mockResolvedValue({ ...current(), isSupportSession: true })
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    p.current.mockResolvedValue(null)
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(p.select).not.toHaveBeenCalled()
  })
  test("native owner requires current CRM admin", async () => {
    p.current.mockResolvedValue({
      ...current(),
      targetWorkspaceMember: { role: "owner", permissions: { flows: true } },
    })
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    p.crm.mockResolvedValue({ allowed: true, role: "admin" })
    expect((await authorizeNativeSourceRequest(target))?.actor).toBe(subject)
  })
  test("CRM approval and native permission checked anew on each request", async () => {
    expect(await authorizeNativeSourceRequest(target)).not.toBeNull()
    p.crm.mockResolvedValue({ allowed: false, role: "member" })
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(p.crm).toHaveBeenCalledTimes(2)
    expect(p.permission).toHaveBeenCalledTimes(2)
    expect(p.current).toHaveBeenCalledTimes(2)
    expect(p.binding).toHaveBeenCalledTimes(1)
  })
  test.each([
    "permission",
    "current",
    "crm",
    "binding",
    "database",
    "config",
  ])("unavailable %s denies without fallback", async (failure) => {
    const error = new Error("synthetic-private-failure")
    if (failure === "database") {
      p.where.mockImplementation(() => {
        throw error
      })
    } else if (failure === "config") {
      p.config.mockImplementation(() => {
        throw error
      })
    } else {
      p[
        failure as "permission" | "current" | "crm" | "binding"
      ].mockRejectedValue(error)
    }
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(await resolveNativeSourceDocument(target)).toEqual(blocked)
  })
  test.each([
    { ...source, flowId: "999" },
    { ...source, workspaceId: "999" },
    blocked,
  ])("saved foreign/blocked binding cannot grant source authority %#", async (binding) => {
    p.binding.mockResolvedValue(binding)
    expect(await authorizeNativeSourceRequest(target)).toBeNull()
    expect(await resolveNativeSourceDocument(target)).toEqual(blocked)
  })
  test("SSR source descriptor runs actual approval guard and blocks revocation", async () => {
    expect(await resolveNativeSourceDocument(target)).toEqual(source)
    p.crm.mockResolvedValue({ allowed: false, role: "member" })
    expect(await resolveNativeSourceDocument(target)).toEqual(blocked)
    expect(p.crm).toHaveBeenCalledTimes(2)
  })
  test("actual transport passes canonical actor, never browser actor/registry/local ID", async () => {
    const request = vi.fn(async () => Response.json({ publishable: false }))
    const response = await forwardNativeSource(
      new Request("https://builder.example.test/ignored?registry=forged", {
        method: "POST",
        headers: {
          Origin: "https://builder.example.test",
          "X-CRM-Actor": "forged",
          "X-Automation-Key": "forged",
        },
        body: "{}",
      }),
      target,
      "validate",
      {
        authorize: authorizeNativeSourceRequest,
        request,
        builderOrigin: "https://builder.example.test",
        apiBase: "https://crm.example.test/api",
        apiKey: "synthetic-service-key",
      },
    )
    expect(response.status).toBe(200)
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toContain(`/bots/${source.registryId}/source-runtime/validate`)
    expect(new Headers(init.headers).get("X-CRM-Actor")).toBe(subject)
    expect(new Headers(init.headers).has("Cookie")).toBe(false)
  })
})

test("native flows revocation is fresh even while CRM remains approved", async () => {
  expect(await authorizeNativeSourceRequest(target)).not.toBeNull()
  p.current.mockResolvedValue({
    ...current(),
    targetWorkspaceMember: { role: "member", permissions: { flows: false } },
  })
  expect(await authorizeNativeSourceRequest(target)).toBeNull()
  expect(p.current).toHaveBeenCalledTimes(2)
  expect(p.permission).toHaveBeenCalledTimes(2)
  expect(p.crm).toHaveBeenCalledTimes(1)
  expect(p.binding).toHaveBeenCalledTimes(1)
})
