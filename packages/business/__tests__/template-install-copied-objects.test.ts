// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  fail: vi.fn(),
  deleteObject: vi.fn(),
  settingsInsert: vi.fn(),
  settingsStage: vi.fn(),
  afterPublish: vi.fn(),
  warn: vi.fn(),
  findByIdAndWorkspace: vi.fn(),
}))

vi.mock("../src/template/sync-hash", () => ({
  stampSyncedHashes: vi.fn(),
}))
vi.mock("../src/coupon/service", () => ({
  couponService: { invalidate: vi.fn() },
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ execute: vi.fn() }),
  },
  sql: { raw: (text: string) => text },
}))

vi.mock("@chatbotx.io/database/statement-timeout", () => ({
  setLocalStatementTimeout: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  templateInstallationRepository: {
    claim: mocks.claim,
    complete: mocks.complete,
    release: mocks.release,
    fail: mocks.fail,
    findByIdAndWorkspace: mocks.findByIdAndWorkspace,
  },
}))

vi.mock("@chatbotx.io/database/schema", () => ({
  templateInstalledResourceModel: {},
}))

vi.mock("@chatbotx.io/events", () => ({ updateTriggerCache: vi.fn() }))

vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { deleteObject: mocks.deleteObject },
}))

vi.mock("../src/logger", () => ({
  logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}))

vi.mock("../src/ai-agent/service", () => ({
  aiAgentService: { invalidate: vi.fn() },
}))
vi.mock("../src/automated-response/service", () => ({
  automatedResponseService: { invalidateCache: vi.fn() },
}))
vi.mock("../src/bot-field/service", () => ({
  botFieldService: { invalidate: vi.fn() },
}))
vi.mock("../src/custom-field/service", () => ({
  customFieldService: { invalidate: vi.fn() },
}))
vi.mock("../src/flow-version", () => ({
  flowVersionService: { afterPublish: mocks.afterPublish },
}))
vi.mock("../src/template/adapters/manifests/resolve", () => ({
  resolveManifests: vi.fn().mockResolvedValue({
    installFolderId: null,
    denied: new Set(),
  }),
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: { invalidateList: vi.fn() },
}))
vi.mock("../src/template/adapters/registry", () => ({
  TEMPLATE_INSTALL_ORDER: ["settings"],
  getTemplateAdapter: (category: string) =>
    category === "settings"
      ? { insert: mocks.settingsInsert, stage: mocks.settingsStage }
      : undefined,
}))

const { templateInstallService } = await import(
  "../src/template/install.service"
)

const payload = {
  source: { workspaceId: "11", tenantId: "1" },
  manifests: {
    folders: [],
    customFields: [],
    tags: [],
    productCategories: [],
  },
  resources: {
    settings: {
      savedReplies: [{ sourceId: "reply-1", kind: "savedReply" }],
      botFields: [],
    },
  },
}

const install = () =>
  templateInstallService.run({
    installationId: "install-1",
    workspaceId: "ws-1",
    claimToken: "token-1",
    payload: payload as never,
    templateName: "Shop",
    createInstallFolder: false,
  })

describe("templateInstallService.run copied storage objects", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteObject.mockResolvedValue(undefined)
    mocks.settingsStage.mockResolvedValue(new Map())
    mocks.complete.mockResolvedValue(true)
    mocks.findByIdAndWorkspace.mockResolvedValue({
      claimToken: "token-1",
      status: "installing",
    })
  })

  test("a flow installed live gets the after-publish effects once the install committed", async () => {
    mocks.settingsInsert.mockImplementation((ctx) => {
      ctx.publishedFlows.push({ flowId: "f1", versionId: "v1" })
      return []
    })

    await install()

    expect(mocks.afterPublish).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      flowId: "f1",
      versionId: "v1",
    })
  })

  test("no after-publish effect runs when the install rolled back", async () => {
    mocks.settingsInsert.mockImplementation((ctx) => {
      ctx.publishedFlows.push({ flowId: "f1", versionId: "v1" })
      throw new Error("adapter failed")
    })

    await expect(install()).rejects.toThrow("adapter failed")

    expect(mocks.afterPublish).not.toHaveBeenCalled()
  })

  test("keys the staged objects per claim, so a lost lease cannot delete the next attempt's", async () => {
    // An earlier test's failing insert would otherwise still be in place.
    mocks.settingsInsert.mockResolvedValue([])
    await install()

    expect(mocks.settingsStage.mock.calls[0][0].installationId).toBe(
      "install-1:token-1",
    )
  })

  test("stages storage objects before the apply transaction opens", async () => {
    const order: string[] = []
    mocks.settingsStage.mockImplementation(() => {
      order.push("stage")
      return Promise.resolve(new Map())
    })
    mocks.settingsInsert.mockImplementation(() => {
      order.push("insert")
      return []
    })

    await install()

    expect(order).toEqual(["stage", "insert"])
  })

  test("deletes objects staged by an attempt whose staging itself failed", async () => {
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("workspaces/ws-1/ai-files/a")
      return Promise.reject(new Error("copy failed"))
    })

    await expect(install()).rejects.toThrow("copy failed")

    expect(mocks.deleteObject).toHaveBeenCalledWith(
      "workspaces/ws-1/ai-files/a",
    )
    expect(mocks.settingsInsert).not.toHaveBeenCalled()
  })

  test("deletes every object the aborted install copied", async () => {
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("public/space/ws-1/media-library/a")
      ctx.trackCopiedObject("public/space/ws-1/media-library/b")
      return new Map()
    })
    mocks.settingsInsert.mockImplementation(() => {
      throw new Error("adapter failed")
    })

    await expect(install()).rejects.toThrow("adapter failed")

    expect(mocks.deleteObject.mock.calls.map((call) => call[0])).toEqual([
      "public/space/ws-1/media-library/a",
      "public/space/ws-1/media-library/b",
    ])
  })

  test("does not delete objects when another attempt has taken over the install", async () => {
    // This attempt only learns it lost the lease at `complete`; by then the
    // winner may reference the same deterministic keys.
    mocks.findByIdAndWorkspace.mockResolvedValue({
      claimToken: "someone-else",
      status: "installing",
    })
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("workspaces/ws-1/ai-files/a")
      return new Map()
    })
    mocks.settingsInsert.mockImplementation(() => {
      throw new Error("adapter failed")
    })

    await expect(install()).rejects.toThrow("adapter failed")

    expect(mocks.deleteObject).not.toHaveBeenCalled()
  })

  test("does not delete objects of an installation that already completed", async () => {
    mocks.findByIdAndWorkspace.mockResolvedValue({
      claimToken: null,
      status: "completed",
    })
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("workspaces/ws-1/ai-files/a")
      return new Map()
    })
    mocks.settingsInsert.mockImplementation(() => {
      throw new Error("adapter failed")
    })

    await expect(install()).rejects.toThrow("adapter failed")

    expect(mocks.deleteObject).not.toHaveBeenCalled()
  })

  test("still reports the install error when a cleanup delete fails", async () => {
    mocks.deleteObject.mockRejectedValue(new Error("storage down"))
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("public/space/ws-1/media-library/a")
      return new Map()
    })
    mocks.settingsInsert.mockImplementation(() => {
      throw new Error("adapter failed")
    })

    await expect(install()).rejects.toThrow("adapter failed")
    expect(mocks.warn).toHaveBeenCalled()
  })
})

describe("templateInstallService lease handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteObject.mockResolvedValue(undefined)
    mocks.settingsStage.mockResolvedValue(new Map())
    mocks.settingsInsert.mockResolvedValue([])
  })

  test("claim returns null for a redelivery or a lease held by another worker", async () => {
    mocks.claim.mockResolvedValue(null)

    await expect(
      templateInstallService.claim({
        installationId: "install-1",
        workspaceId: "ws-1",
      }),
    ).resolves.toBeNull()
  })

  test("claim hands the winner its token and a lease cutoff", async () => {
    mocks.claim.mockResolvedValue({ id: "install-1" })

    const claim = await templateInstallService.claim({
      installationId: "install-1",
      workspaceId: "ws-1",
    })

    expect(claim?.claimToken).toEqual(expect.any(String))
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "install-1",
        workspaceId: "ws-1",
        claimToken: claim?.claimToken,
        leaseExpiredBefore: expect.any(Date),
      }),
    )
  })

  test("commits completion fenced by the claim token", async () => {
    mocks.complete.mockResolvedValue(true)

    await install()

    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "install-1", claimToken: "token-1" }),
      expect.anything(),
    )
  })

  test("a lost lease never deletes objects the winning worker may reference", async () => {
    mocks.complete.mockResolvedValue(false)
    mocks.settingsStage.mockImplementation((ctx) => {
      ctx.trackCopiedObject("public/space/ws-1/media-library/a")
      return new Map()
    })
    mocks.settingsInsert.mockImplementation(() => [])

    await expect(install()).rejects.toMatchObject({
      code: "templateInstallLeaseLost",
    })

    expect(mocks.deleteObject).not.toHaveBeenCalled()
  })

  test("rolls the whole install back when the lease was lost", async () => {
    mocks.complete.mockResolvedValue(false)

    await expect(install()).rejects.toMatchObject({
      code: "templateInstallLeaseLost",
    })
  })
})
