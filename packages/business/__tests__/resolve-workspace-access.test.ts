import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { resolveWorkspaceAccess } from "../src/workspace-support-access/resolve-access"

const mocks = vi.hoisted(() => ({
  findForAuth: vi.fn(),
  isSuperAdmin: vi.fn(),
  isSupportConsentRequired: vi.fn(),
}))

vi.mock("../src/user/utils", () => ({
  isSuperAdmin: mocks.isSuperAdmin,
}))
vi.mock("../src/workspace-support-access/consent", () => ({
  isSupportConsentRequired: mocks.isSupportConsentRequired,
}))
vi.mock("../src/workspace/service", () => ({
  workspaceService: { findForAuth: mocks.findForAuth },
}))
vi.mock("../src/workspace-member/service", () => ({
  workspaceMemberService: { findMembership: vi.fn() },
}))

const user = { id: "user-1", email: "admin@chatbotx.io" }

afterEach(() => vi.unstubAllEnvs())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isSupportConsentRequired.mockResolvedValue(true)
})

describe("resolveWorkspaceAccess", () => {
  test.each([
    "11759896832695848",
    "999",
  ])("SUPAlogin restricts existing membership to the shared workspace: %s", async (workspaceId) => {
    vi.stubEnv("SUPALOGIN_ISSUER", "https://login.example.test")
    vi.stubEnv("SUPABUILDER_WORKSPACE_ID", "11759896832695848")
    const realMember = {
      userId: user.id,
      permissions: { superAdmin: true } as never,
      workspace: { id: workspaceId, supportAccessUntil: null } as never,
    }
    const result = await resolveWorkspaceAccess({
      realMember,
      workspaceId,
      user,
    })
    expect(Boolean(result)).toBe(workspaceId === "11759896832695848")
  })

  test("SUPAlogin prevents platform support from entering another workspace", async () => {
    vi.stubEnv("SUPALOGIN_ISSUER", "https://login.example.test")
    vi.stubEnv("SUPABUILDER_WORKSPACE_ID", "11759896832695848")
    mocks.isSuperAdmin.mockResolvedValue(true)
    mocks.isSupportConsentRequired.mockResolvedValue(false)
    mocks.findForAuth.mockResolvedValue({ id: "999", supportAccessUntil: null })
    expect(
      await resolveWorkspaceAccess({
        realMember: undefined,
        workspaceId: "999",
        user,
      }),
    ).toBeUndefined()
  })

  test("uses the real member's attached workspace without calling workspaceService.findForAuth", async () => {
    const realMember = {
      userId: "user-1",
      permissions: { superAdmin: false } as never,
      workspace: { id: "workspace-1", supportAccessUntil: null } as never,
    }

    const result = await resolveWorkspaceAccess({
      realMember,
      workspaceId: "workspace-1",
      user,
    })

    expect(result).toEqual({
      workspace: realMember.workspace,
      member: realMember,
      isSupportSession: false,
    })
    expect(mocks.findForAuth).not.toHaveBeenCalled()
  })

  test("fetches the workspace and synthesizes a support session when the caller is super admin and support access is enabled", async () => {
    mocks.isSuperAdmin.mockResolvedValue(true)
    const workspace = {
      id: "workspace-1",
      supportAccessUntil: new Date(Date.now() + 60_000),
    }
    mocks.findForAuth.mockResolvedValue(workspace)

    const result = await resolveWorkspaceAccess({
      realMember: undefined,
      workspaceId: "workspace-1",
      user,
    })

    expect(mocks.findForAuth).toHaveBeenCalledWith({ id: "workspace-1" })
    expect(result?.isSupportSession).toBe(true)
    expect(result?.workspace).toBe(workspace)
    expect(result?.member.userId).toBe("user-1")
  })

  test("keeps isSupportSession true when enterprise policy disables consent", async () => {
    mocks.isSuperAdmin.mockResolvedValue(true)
    mocks.isSupportConsentRequired.mockResolvedValue(false)
    mocks.findForAuth.mockResolvedValue({
      id: "workspace-1",
      supportAccessUntil: null,
    })

    const result = await resolveWorkspaceAccess({
      realMember: undefined,
      workspaceId: "workspace-1",
      user,
    })

    expect(result?.isSupportSession).toBe(true)
  })

  test("returns undefined when support access is not enabled and consent is required", async () => {
    mocks.isSuperAdmin.mockResolvedValue(true)
    mocks.findForAuth.mockResolvedValue({
      id: "workspace-1",
      supportAccessUntil: null,
    })

    const result = await resolveWorkspaceAccess({
      realMember: undefined,
      workspaceId: "workspace-1",
      user,
    })

    expect(result).toBeUndefined()
  })

  test("returns undefined when the workspace does not exist", async () => {
    mocks.findForAuth.mockResolvedValue(undefined)

    const result = await resolveWorkspaceAccess({
      realMember: undefined,
      workspaceId: "missing",
      user,
    })

    expect(result).toBeUndefined()
  })
})
