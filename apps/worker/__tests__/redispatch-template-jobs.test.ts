// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  abandonStale: vi.fn(),
  listStale: vi.fn(),
  enqueueInstallTemplate: vi.fn(),
  enqueueProcessAIFile: vi.fn(),
  listForSweep: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  templateAiFileDispatchService: { listForSweep: mocks.listForSweep },
  templateInstallService: {
    abandonStale: mocks.abandonStale,
    listStale: mocks.listStale,
  },
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  enqueueInstallTemplate: mocks.enqueueInstallTemplate,
  enqueueProcessAIFile: mocks.enqueueProcessAIFile,
}))
vi.mock("@chatbotx.io/logger", () => ({
  getChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { redispatchTemplateJobs } = await import(
  "../src/schedule/handlers/redispatch-template-jobs"
)

describe("redispatchTemplateJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.abandonStale.mockResolvedValue(0)
    mocks.enqueueInstallTemplate.mockResolvedValue(undefined)
    mocks.enqueueProcessAIFile.mockResolvedValue(undefined)
    mocks.listForSweep.mockResolvedValue({ redispatch: [], expired: 0 })
  })

  test("re-enqueues every stale installation with its workspace", async () => {
    mocks.listStale.mockResolvedValue([
      { id: "install-1", workspaceId: "ws-1" },
      { id: "install-2", workspaceId: "ws-2" },
    ])

    await redispatchTemplateJobs()

    expect(mocks.enqueueInstallTemplate).toHaveBeenCalledWith({
      installationId: "install-1",
      workspaceId: "ws-1",
    })
    expect(mocks.enqueueInstallTemplate).toHaveBeenCalledWith({
      installationId: "install-2",
      workspaceId: "ws-2",
    })
  })

  test("closes abandoned installations before listing the rest", async () => {
    mocks.abandonStale.mockResolvedValue(3)
    mocks.listStale.mockResolvedValue([])

    await redispatchTemplateJobs()

    expect(mocks.abandonStale).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueInstallTemplate).not.toHaveBeenCalled()
  })

  test("one failed enqueue does not stop the others", async () => {
    mocks.listStale.mockResolvedValue([
      { id: "install-1", workspaceId: "ws-1" },
      { id: "install-2", workspaceId: "ws-2" },
    ])
    mocks.enqueueInstallTemplate.mockRejectedValueOnce(new Error("redis down"))

    await expect(redispatchTemplateJobs()).resolves.toBeUndefined()
    expect(mocks.enqueueInstallTemplate).toHaveBeenCalledTimes(2)
  })

  test("re-enqueues the queued AI files of installs, and tolerates one failing", async () => {
    mocks.listStale.mockResolvedValue([])
    mocks.listForSweep.mockResolvedValue({
      redispatch: [
        { aiFileId: "f1", runId: "r1" },
        { aiFileId: "f2", runId: "r2" },
      ],
      expired: 0,
    })
    mocks.enqueueProcessAIFile.mockRejectedValueOnce(new Error("redis"))

    await expect(redispatchTemplateJobs()).resolves.toBeUndefined()

    expect(mocks.enqueueProcessAIFile).toHaveBeenCalledWith({
      aiFileId: "f1",
      runId: "r1",
    })
    expect(mocks.enqueueProcessAIFile).toHaveBeenCalledWith({
      aiFileId: "f2",
      runId: "r2",
    })
  })
})
