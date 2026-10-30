import { beforeEach, describe, expect, test, vi } from "vitest"
import type { SupaLoginConfig } from "../src/supalogin-config"

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
  checkCrmAccess: vi.fn(),
  invalidateCacheByTags: vi.fn(),
  revokeRealtime: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
    transaction: mocks.transaction,
  },
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  ROOT_TENANT_ID: "1",
  workspaceModel: { id: "workspace.id", tenantId: "workspace.tenantId" },
  accountModel: {
    userId: "account.userId",
    providerId: "account.providerId",
    accountId: "account.accountId",
    tenantId: "account.tenantId",
  },
  sessionModel: { userId: "session.userId" },
  userModel: { id: "user.id", email: "user.email", tenantId: "user.tenantId" },
  workspaceMemberModel: {
    id: "member.id",
    workspaceId: "member.workspaceId",
    userId: "member.userId",
  },
}))
vi.mock("@chatbotx.io/database/partials", () => ({
  workspaceMemberRoles: { enum: { owner: "owner" } },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  workspaceMemberRepository: {},
}))
vi.mock("@chatbotx.io/database/utils", () => ({
  getPaginationWithDefaults: vi.fn(),
  likeContains: vi.fn(),
}))
vi.mock("../../redis/src/index", () => ({
  withCache: vi.fn(),
  invalidateCacheByTags: mocks.invalidateCacheByTags,
}))
vi.mock("../../business/src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(),
}))
vi.mock("../../business/src/platform/realtime-broadcast", () => ({
  tryRevokeWorkspaceMemberRealtimeConnections: mocks.revokeRealtime,
}))
vi.mock("../../business/src/workspace-usage/service", () => ({
  workspaceUsageService: {},
}))
vi.mock("../../business/src/working-hours/service", () => ({
  workingHoursService: {},
}))
vi.mock("@chatbotx.io/business", async () => {
  const { workspaceMemberService } = await import(
    "../../business/src/workspace-member/service"
  )
  return { workspaceMemberService }
})
vi.mock("../src/supalogin-config", () => ({
  checkCrmAccess: mocks.checkCrmAccess,
}))

const { authorizeSupaLoginSession, provisionSupaLoginUser } = await import(
  "../src/supalogin-membership"
)

const config: SupaLoginConfig = {
  issuer: "https://login.example.test",
  clientId: "supabuilder",
  origin: "https://builder.example.test",
  workspaceId: "42",
  accessUrl: "https://crm.example.test/api/auth/supabuilder/access",
  accessKey: "synthetic-crm-key-for-tests-only-123456",
  bootstrapSubject: "subject-owner",
}
const identity = { userId: "subject-owner", email: "owner@example.test" }
const permissions = {
  superAdmin: false,
  analytics: true,
  flows: true,
  contacts: true,
  onlyAssignedContacts: false,
  emailAndPhone: true,
  broadcast: false,
  ecommerce: false,
}
const deniedPermissions = {
  ...permissions,
  analytics: false,
  flows: false,
  contacts: false,
  emailAndPhone: false,
}

type Row = Record<string, unknown>
function selection(rows: Row[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi
        .fn()
        .mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkCrmAccess.mockResolvedValue({ allowed: true, role: "member" })
  mocks.update.mockReturnValue({ set: mocks.updateSet })
  mocks.updateSet.mockReturnValue({ where: mocks.updateWhere })
  mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning })
  mocks.updateReturning.mockResolvedValue([
    { id: "member-1", userId: "builder-user-1" },
  ])
  mocks.invalidateCacheByTags.mockResolvedValue(undefined)
  mocks.revokeRealtime.mockResolvedValue(true)
})

function sessionRows(role: "owner" | "agent", superAdmin: boolean) {
  mocks.select
    .mockReturnValueOnce(
      selection([{ accountId: `${config.issuer}|subject-1` }]),
    )
    .mockReturnValueOnce(
      selection([
        { id: "member-1", role, permissions: { ...permissions, superAdmin } },
      ]),
    )
}

const sessionUser = { id: "builder-user-1", email: "member@example.test" }

function expectRevocation() {
  expect(mocks.invalidateCacheByTags).toHaveBeenCalledExactlyOnceWith([
    "users:builder-user-1:workspace-members",
    "workspaces:42:workspace-members",
  ])
  expect(mocks.revokeRealtime).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "42",
    userId: "builder-user-1",
    reason: "reauth",
    errorMessage: "Failed to revoke workspace member realtime connections",
  })
  expect(mocks.updateReturning.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.invalidateCacheByTags.mock.invocationCallOrder[0],
  )
  expect(mocks.invalidateCacheByTags.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.revokeRealtime.mock.invocationCallOrder[0],
  )
}

describe("проверка сессии SUPAlogin и реальный workspaceMemberService.update", () => {
  test("понижение CRM admin до member убирает superAdmin, сбрасывает кеши и отзывает realtime", async () => {
    sessionRows("agent", true)
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(true)
    expect(mocks.checkCrmAccess).toHaveBeenCalledWith(config, {
      userId: "subject-1",
      email: sessionUser.email,
    })
    expect(mocks.updateSet).toHaveBeenCalledExactlyOnceWith({ permissions })
    expect(mocks.updateWhere).toHaveBeenCalledWith({
      and: [
        { eq: ["member.id", "member-1"] },
        { eq: ["member.workspaceId", "42"] },
      ],
    })
    expectRevocation()
  })

  test("владелец после потери роли CRM admin лишается сессии, полномочий и realtime", async () => {
    sessionRows("owner", true)
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(false)
    expect(mocks.updateSet).toHaveBeenCalledExactlyOnceWith({
      permissions: deniedPermissions,
    })
    expectRevocation()
  })

  test("полный отзыв доступа CRM очищает полномочия обычного участника", async () => {
    sessionRows("agent", true)
    mocks.checkCrmAccess.mockResolvedValue({ allowed: false, role: "admin" })
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(false)
    expect(mocks.updateSet).toHaveBeenCalledExactlyOnceWith({
      permissions: deniedPermissions,
    })
    expectRevocation()
  })

  test("неизменённые права не вызывают лишнее обновление и отзыв realtime", async () => {
    sessionRows("agent", false)
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(true)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.invalidateCacheByTags).not.toHaveBeenCalled()
    expect(mocks.revokeRealtime).not.toHaveBeenCalled()
  })

  test("ошибка CRM запрещает сессию", async () => {
    mocks.select.mockReturnValueOnce(
      selection([{ accountId: `${config.issuer}|subject-1` }]),
    )
    mocks.checkCrmAccess.mockRejectedValue(new Error("CRM unavailable"))
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  test("чужой issuer не используется для проверки CRM", async () => {
    mocks.select.mockReturnValueOnce(
      selection([{ accountId: "https://other.example.test|subject-1" }]),
    )
    expect(await authorizeSupaLoginSession(config, sessionUser)).toBe(false)
    expect(mocks.checkCrmAccess).not.toHaveBeenCalled()
  })
})

describe("привязка технического владельца в одной транзакции", () => {
  test("bootstrap удаляет старые сессии и только credential владельца до привязки identity", async () => {
    mocks.checkCrmAccess.mockResolvedValue({ allowed: true, role: "admin" })
    const deletions: Array<{ table: unknown; condition: unknown }> = []
    const events: string[] = []
    const deleteWhere = vi.fn()
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce(selection([{ id: "42", ownerId: "owner-1" }]))
        .mockReturnValueOnce(selection([]))
        .mockReturnValueOnce(selection([]))
        .mockReturnValueOnce(
          selection([{ id: "owner-1", email: identity.email }]),
        )
        .mockReturnValueOnce(selection([{ id: "owner-member-1" }])),
      delete: vi.fn((table: unknown) => ({
        where: (condition: unknown) => {
          deletions.push({ table, condition })
          events.push("delete")
          return deleteWhere(condition)
        },
      })),
      update: vi.fn(() => ({
        set: (data: unknown) => ({
          where: vi.fn(() => {
            events.push("update")
            return Promise.resolve(data)
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((data: unknown) => {
          events.push("link")
          return Promise.resolve(data)
        }),
      })),
    }
    mocks.transaction.mockImplementation(
      async (operation: (transaction: typeof tx) => Promise<unknown>) => {
        events.push("begin")
        const result = await operation(tx)
        events.push("commit")
        return result
      },
    )
    expect(await provisionSupaLoginUser(config, identity)).toBe("owner-1")
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(deletions).toEqual([
      {
        table: { userId: "session.userId" },
        condition: { eq: ["session.userId", "owner-1"] },
      },
      {
        table: expect.objectContaining({ providerId: "account.providerId" }),
        condition: {
          and: [
            { eq: ["account.userId", "owner-1"] },
            { eq: ["account.providerId", "credential"] },
          ],
        },
      },
    ])
    expect(events).toEqual([
      "begin",
      "delete",
      "delete",
      "update",
      "link",
      "update",
      "commit",
    ])
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  test("отказ CRM останавливает bootstrap до начала транзакции", async () => {
    mocks.checkCrmAccess.mockResolvedValue({ allowed: false, role: "admin" })
    await expect(provisionSupaLoginUser(config, identity)).rejects.toThrow(
      "CRM access denied",
    )
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
