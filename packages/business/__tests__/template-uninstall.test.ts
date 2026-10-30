// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findInstallation: vi.fn(),
  lockInstall: vi.fn(),
  listActiveByRef: vi.fn(),
  markUninstalled: vi.fn(),
  listInstalled: vi.fn(),
  detach: vi.fn(),
  project: vi.fn(),
  lockKeywords: vi.fn(),
  findReferenced: vi.fn(),
  findLockedByOthers: vi.fn(),
  deleteMany: vi.fn(),
  hasRunningSync: vi.fn(),
  cancelPending: vi.fn(),
  freezeReason: vi.fn(),
  templateFindFirst: vi.fn(),
  workspaceFindFirst: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => {
  return {
    db: {
      query: {
        templateModel: { findFirst: mocks.templateFindFirst },
        workspaceModel: { findFirst: mocks.workspaceFindFirst },
      },
      // A fresh transaction per call: lock bookkeeping is per transaction.
      transaction: (callback: (client: unknown) => unknown) =>
        callback({ execute: vi.fn() }),
    },
    and: vi.fn(),
    eq: vi.fn(),
    inArray: vi.fn(),
  }
})
vi.mock("@chatbotx.io/database/schema", () => ({
  automatedResponseModel: {},
}))
vi.mock("@chatbotx.io/database/statement-timeout", () => ({
  setLocalStatementTimeout: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  templateInstallationRepository: {
    findByIdAndWorkspace: mocks.findInstallation,
    lockInstallRequest: mocks.lockInstall,
    listActiveByPublisherRef: mocks.listActiveByRef,
    markUninstalled: mocks.markUninstalled,
  },
  templateInstallationSyncRepository: {
    listInstalledResources: mocks.listInstalled,
    detachResources: mocks.detach,
  },
  templateUninstallRepository: {
    lockKeywords: mocks.lockKeywords,
    findReferencedKeywordIds: mocks.findReferenced,
    findDeleteBlockedByOthers: mocks.findLockedByOthers,
    hasRunningSync: mocks.hasRunningSync,
    cancelPendingSyncs: mocks.cancelPending,
  },
}))
vi.mock("../src/workspace-lifecycle/with-blocked-owner-guard", () => ({
  resolveWorkspaceFreezeReasonById: async () => ({
    freezeReason: await mocks.freezeReason(),
  }),
}))
vi.mock("../src/automated-response/service", () => ({
  automatedResponseService: {
    invalidateCache: mocks.invalidate,
    deleteMany: mocks.deleteMany,
  },
}))
vi.mock("../src/template/adapters/registry", () => ({
  getTemplateAdapter: (category: string) =>
    category === "keywords" ? { sync: { project: mocks.project } } : undefined,
}))

const { templateUninstallService: service } = await import(
  "../src/template/uninstall.service"
)
const { hashCanonical } = await import("../src/template/payload-hash")

const installerActor = { kind: "apiToken", permission: "full" } as const
const base = {
  workspaceId: "ws-1",
  installationId: "inst-1",
  actor: installerActor,
}
const installation = (overrides: Record<string, unknown> = {}) => ({
  id: "inst-1",
  workspaceId: "ws-1",
  sourceTemplateId: "tpl-1",
  status: "completed",
  publisherUninstallGrant: 1,
  ...overrides,
})
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "row-1",
  category: "keywords",
  resourceKind: "automatedResponse",
  resourceId: "kw-1",
  wasExisting: false,
  detachedAt: null,
  syncedHash: null as string | null,
  ...overrides,
})

const deletedIds = (): string[] =>
  mocks.deleteMany.mock.calls.flatMap(([, ids]: [string, string[]]) => ids)

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.findInstallation.mockResolvedValue(installation())
  mocks.hasRunningSync.mockResolvedValue(false)
  mocks.freezeReason.mockResolvedValue(null)
  mocks.lockKeywords.mockResolvedValue(new Map([["kw-1", "inbound"]]))
  mocks.findReferenced.mockResolvedValue(new Set())
  mocks.findLockedByOthers.mockResolvedValue(new Set())
  mocks.markUninstalled.mockResolvedValue(true)
  mocks.project.mockResolvedValue({ text: "hi" })
  mocks.listInstalled.mockResolvedValue([
    row({ syncedHash: await hashCanonical({ text: "hi" }) }),
  ])
})

describe("uninstall: what happens to each copy", () => {
  test("deletes an unmodified keyword and releases every lock", async () => {
    const counts = await service.uninstallAsInstaller(base)

    expect(counts).toEqual({
      deleted: 1,
      keptModified: 0,
      keptShared: 0,
      keptByPolicy: 0,
      keptHasDependents: 0,
    })
    // The service is the single delete implementation; this installation's
    // own locks are excluded because it detaches them in the same transaction.
    expect(mocks.deleteMany).toHaveBeenCalledWith(
      "ws-1",
      ["kw-1"],
      "inbound",
      expect.anything(),
      { excludeInstallationIds: ["inst-1"] },
    )
    expect(mocks.cancelPending).toHaveBeenCalledWith(
      "inst-1",
      expect.anything(),
    )
    expect(mocks.detach).toHaveBeenCalledWith(["row-1"], expect.anything())
    expect(mocks.markUninstalled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inst-1", requestedBy: "installer" }),
      expect.anything(),
    )
    expect(mocks.invalidate).toHaveBeenCalledWith("ws-1")
  })

  test("keeps a keyword the installer edited", async () => {
    mocks.project.mockResolvedValue({ text: "edited by me" })
    const counts = await service.uninstallAsInstaller(base)

    expect(counts).toMatchObject({ deleted: 0, keptModified: 1 })
    expect(deletedIds()).toEqual([])
    expect(mocks.detach).toHaveBeenCalledWith(["row-1"], expect.anything())
  })

  test("a copy with no recorded baseline is treated as edited", async () => {
    mocks.listInstalled.mockResolvedValue([row({ syncedHash: null })])
    expect(await service.uninstallAsInstaller(base)).toMatchObject({
      deleted: 0,
      keptModified: 1,
    })
  })

  test("keeps shared tags and fields, and kinds it does not delete", async () => {
    mocks.listInstalled.mockResolvedValue([
      row({ id: "t", resourceKind: "tag", category: "tags" }),
      row({ id: "f", resourceKind: "flow", category: "flows" }),
    ])
    const counts = await service.uninstallAsInstaller(base)

    expect(counts).toEqual({
      deleted: 0,
      keptModified: 0,
      keptShared: 1,
      keptByPolicy: 1,
      keptHasDependents: 0,
    })
    expect(deletedIds()).toEqual([])
    expect(mocks.detach).toHaveBeenCalledWith(["t", "f"], expect.anything())
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  test("never touches a copy the installer already owned", async () => {
    mocks.listInstalled.mockResolvedValue([row({ wasExisting: true })])
    const counts = await service.uninstallAsInstaller(base)
    expect(counts).toEqual({
      deleted: 0,
      keptModified: 0,
      keptShared: 0,
      keptByPolicy: 0,
      keptHasDependents: 0,
    })
    expect(mocks.detach).toHaveBeenCalledWith([], expect.anything())
  })

  test("a copy the installer already deleted is neither counted nor recreated", async () => {
    mocks.project.mockResolvedValue(null)
    const counts = await service.uninstallAsInstaller(base)
    expect(counts.deleted).toBe(0)
    expect(deletedIds()).toEqual([])
  })

  test("a preview decides the same way and writes nothing", async () => {
    const counts = await service.previewAsInstaller(base)

    expect(counts.deleted).toBe(1)
    expect(deletedIds()).toEqual([])
    expect(mocks.detach).not.toHaveBeenCalled()
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
  })
})

describe("uninstall: keywords other things depend on", () => {
  test("keeps and detaches a keyword a filter or ads rule still references", async () => {
    mocks.findReferenced.mockResolvedValue(new Set(["kw-1"]))
    const counts = await service.uninstallAsInstaller(base)

    // Counted as `keptHasDependents`, not `keptShared`.
    expect(counts).toMatchObject({
      deleted: 0,
      keptShared: 0,
      keptHasDependents: 1,
    })
    expect(deletedIds()).toEqual([])
    expect(mocks.detach).toHaveBeenCalledWith(["row-1"], expect.anything())
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  test("keeps a keyword another installation still locks, excluding only this one", async () => {
    mocks.findLockedByOthers.mockResolvedValue(new Set(["kw-1"]))
    const counts = await service.uninstallAsInstaller(base)

    expect(counts).toMatchObject({ deleted: 0, keptShared: 1 })
    expect(deletedIds()).toEqual([])
    expect(mocks.findLockedByOthers).toHaveBeenCalledWith(
      expect.objectContaining({ excludeInstallationIds: ["inst-1"] }),
      expect.anything(),
    )
  })

  test("locks the keyword rows before reading them, so a racing edit waits", async () => {
    await service.uninstallAsInstaller(base)
    expect(mocks.lockKeywords).toHaveBeenCalledWith(
      { workspaceId: "ws-1", ids: ["kw-1"] },
      expect.anything(),
    )
    expect(mocks.lockKeywords.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.project.mock.invocationCallOrder[0],
    )
  })

  test("a keyword that vanished under the lock is neither counted nor deleted", async () => {
    mocks.lockKeywords.mockResolvedValue(new Map())
    const counts = await service.uninstallAsInstaller(base)
    expect(counts.deleted).toBe(0)
    expect(deletedIds()).toEqual([])
  })

  test("deletes each keyword with the type read from its locked row", async () => {
    mocks.lockKeywords.mockResolvedValue(new Map([["kw-1", "outbound"]]))
    await service.uninstallAsInstaller(base)
    expect(mocks.deleteMany).toHaveBeenCalledWith(
      "ws-1",
      ["kw-1"],
      "outbound",
      expect.anything(),
      expect.anything(),
    )
  })
})

describe("uninstall: who may, and when", () => {
  test("a read-only token can not uninstall", async () => {
    await expect(
      service.uninstallAsInstaller({
        ...base,
        actor: { kind: "apiToken", permission: "read_only" },
      }),
    ).rejects.toMatchObject({ code: "templateManagePermissionDenied" })
  })

  test("a read-only token may still preview", async () => {
    const counts = await service.previewAsInstaller({
      ...base,
      actor: { kind: "apiToken", permission: "read_only" },
    })
    expect(counts.deleted).toBe(1)
  })

  test("a member needs flows to uninstall, even for an ecommerce-only install", async () => {
    await expect(
      service.uninstallAsInstaller({
        ...base,
        actor: { kind: "member", permissions: { ecommerce: true } },
      }),
    ).rejects.toMatchObject({ code: "templateManagePermissionDenied" })
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
  })

  test("a member with flows still needs the permission of what the install holds", async () => {
    mocks.listInstalled.mockResolvedValue([
      row({ category: "products", resourceKind: "product" }),
    ])
    await expect(
      service.uninstallAsInstaller({
        ...base,
        actor: { kind: "member", permissions: { flows: true } },
      }),
    ).rejects.toMatchObject({ code: "templateCategoryPermissionDenied" })
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
  })

  test("a queued sync is cancelled, not a reason to refuse; a preview cancels nothing", async () => {
    await service.previewAsInstaller(base)
    expect(mocks.cancelPending).not.toHaveBeenCalled()
    await service.uninstallAsInstaller(base)
    expect(mocks.cancelPending).toHaveBeenCalledTimes(1)
  })

  test("is refused while a sync of the installation runs", async () => {
    mocks.hasRunningSync.mockResolvedValue(true)
    await expect(service.uninstallAsInstaller(base)).rejects.toMatchObject({
      code: "templateUninstallInProgress",
    })
  })

  test.each([
    ["uninstalled", { status: "uninstalled" }],
    ["failed", { status: "failed" }],
    ["another workspace's", { workspaceId: "ws-2" }],
  ])("%s installation is not found", async (_label, patch) => {
    mocks.findInstallation.mockResolvedValue(installation(patch))
    await expect(service.uninstallAsInstaller(base)).rejects.toThrow(
      "Template installation not found",
    )
  })

  test("takes the install lock so it can not interleave with a sync", async () => {
    await service.uninstallAsInstaller(base)
    expect(mocks.lockInstall).toHaveBeenCalledWith(
      { workspaceId: "ws-1", sourceTemplateId: "tpl-1" },
      expect.anything(),
    )
  })
})

describe("uninstall by the publisher", () => {
  const publisher = {
    workspaceId: "src-ws",
    templateId: "tpl-1",
    publisherRef: "a".repeat(32),
    actor: { kind: "member", permissions: { flows: true } } as const,
  }
  beforeEach(() => {
    mocks.templateFindFirst.mockResolvedValue({ id: "tpl-1", tenantId: "1" })
    mocks.listActiveByRef.mockResolvedValue([installation()])
    mocks.workspaceFindFirst.mockResolvedValue({ tenantId: "1" })
  })

  test("uninstalls every active copy of the installer and sums the outcome", async () => {
    mocks.listActiveByRef.mockResolvedValue([
      installation(),
      installation({ id: "inst-2" }),
    ])
    mocks.findInstallation.mockImplementation(async ({ id }: { id: string }) =>
      installation({ id }),
    )
    const result = await service.uninstallAsPublisher(publisher)

    expect(result.installations).toBe(2)
    expect(result.counts.deleted).toBe(2)
    expect(mocks.markUninstalled).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: "publisher" }),
      expect.anything(),
    )
  })

  test("a frozen target workspace refuses a publisher uninstall, not a preview", async () => {
    mocks.freezeReason.mockResolvedValue("ownerBlocked")
    await expect(service.uninstallAsPublisher(publisher)).rejects.toMatchObject(
      { code: "templateUninstallTargetBlocked" },
    )
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
    await expect(service.previewAsPublisher(publisher)).resolves.toBeDefined()
  })

  test("a failure mid-loop returns the progress made; a retry finishes the rest", async () => {
    mocks.listActiveByRef.mockResolvedValue([
      installation(),
      installation({ id: "inst-2" }),
    ])
    mocks.findInstallation.mockImplementation(async ({ id }: { id: string }) =>
      installation({ id }),
    )
    mocks.markUninstalled
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const result = await service.uninstallAsPublisher(publisher)

    expect(result.installations).toBe(2)
    expect(result.done).toBe(1)
    expect(result.counts.deleted).toBe(1)
    expect(result.failures).toEqual([
      { installationId: "inst-2", code: "templateUninstallInProgress" },
    ])

    // Retry: only the unfinished installation is still active.
    mocks.listActiveByRef.mockResolvedValue([installation({ id: "inst-2" })])
    mocks.markUninstalled.mockResolvedValue(true)
    const retry = await service.uninstallAsPublisher(publisher)
    expect(retry).toMatchObject({ installations: 1, done: 1, failures: [] })
  })

  test("needs the manage permission in the publishing workspace", async () => {
    await expect(
      service.uninstallAsPublisher({
        ...publisher,
        actor: { kind: "member", permissions: { ecommerce: true } },
      }),
    ).rejects.toMatchObject({ code: "templateManagePermissionDenied" })
  })

  test("is refused unless every active copy granted it", async () => {
    mocks.listActiveByRef.mockResolvedValue([
      installation(),
      installation({ id: "inst-2", publisherUninstallGrant: 0 }),
    ])
    await expect(service.uninstallAsPublisher(publisher)).rejects.toMatchObject(
      { code: "templateUninstallNotGranted" },
    )
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
  })

  test("consent revoked between the check and the lock stops the uninstall", async () => {
    // The first read (outside the lock) still shows the grant; the row read
    // under the lock has been revoked since.
    mocks.findInstallation.mockImplementation(async () =>
      installation({ publisherUninstallGrant: 0 }),
    )
    await expect(service.uninstallAsPublisher(publisher)).rejects.toMatchObject(
      { code: "templateUninstallNotGranted" },
    )
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
    expect(deletedIds()).toEqual([])
  })

  test("a template of another workspace is not found", async () => {
    mocks.templateFindFirst.mockResolvedValue(undefined)
    await expect(service.uninstallAsPublisher(publisher)).rejects.toThrow(
      "Template not found",
    )
  })

  test("a tenant mismatch is treated as not found", async () => {
    mocks.workspaceFindFirst.mockResolvedValue({ tenantId: "2" })
    await expect(service.uninstallAsPublisher(publisher)).rejects.toThrow(
      "Template installation not found",
    )
  })

  test("an unknown installer reference is not found", async () => {
    mocks.listActiveByRef.mockResolvedValue([])
    await expect(service.uninstallAsPublisher(publisher)).rejects.toThrow(
      "Template installation not found",
    )
  })

  test("a preview writes nothing", async () => {
    const result = await service.previewAsPublisher(publisher)
    expect(result.counts.deleted).toBe(1)
    expect(mocks.markUninstalled).not.toHaveBeenCalled()
  })
})

describe("describeUninstall", () => {
  test("exposes who uninstalled and what happened, only once uninstalled", async () => {
    const { describeUninstall } = await import(
      "../src/template/uninstall.service"
    )
    const counts = {
      deleted: 1,
      keptModified: 2,
      keptShared: 0,
      keptByPolicy: 0,
    }
    expect(
      describeUninstall({
        status: "uninstalled",
        uninstalledAt: new Date(0),
        uninstalledByKind: "publisher",
        uninstallCounts: counts,
      }),
    ).toEqual({
      uninstalledAt: new Date(0),
      uninstalledBy: "publisher",
      counts,
    })
    expect(describeUninstall({ status: "completed" })).toBeNull()
  })
})
