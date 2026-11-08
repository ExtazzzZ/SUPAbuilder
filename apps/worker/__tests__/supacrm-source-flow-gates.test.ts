import { beforeEach, describe, expect, test, vi } from "vitest"

const { boundary, active, version, actualTx } = vi.hoisted(() => ({
  boundary: vi.fn(),
  active: vi.fn(),
  version: vi.fn(),
  actualTx: { owner: "synthetic-worker-unit-transaction" },
}))
vi.mock("@chatbotx.io/business", () => ({
  flowService: { findActiveById: active },
  flowVersionService: { findByIdForWorkspace: version },
  supacrmSourceBindingService: { withLegacyFlow: boundary },
}))
vi.mock("@chatbotx.io/database/client", () => ({ findOrFail: vi.fn() }))
const { detectFlowVersion } = await import("../src/lib/db")
const scope = { workspaceId: "1", flowId: "2" }
const saved = { id: "3", ...scope }

beforeEach(() => {
  vi.resetAllMocks()
  boundary.mockImplementation((_scope, work) => work(actualTx))
  version.mockResolvedValue(saved)
  active.mockResolvedValue({ id: "2", workspaceId: "1", currentVersionId: "3" })
})

describe("Worker owning Flow gate: unit wiring, без утверждений о PostgreSQL", () => {
  test("pinned lookup выполняется внутри gate с точным tx и scope", async () => {
    expect(await detectFlowVersion({ ...scope, flowVersionId: "3" })).toEqual({
      flowVersion: saved,
      useLatestFlowVersion: false,
    })
    expect(boundary).toHaveBeenCalledWith(
      { ...scope, operation: "execute" },
      expect.any(Function),
    )
    expect(version).toHaveBeenCalledWith({
      versionId: "3",
      workspaceId: "1",
      tx: actualTx,
    })
    expect(boundary.mock.invocationCallOrder[0]).toBeLessThan(
      version.mock.invocationCallOrder[0],
    )
    expect(active).not.toHaveBeenCalled()
  })
  test("latest lookup и active Flow читаются тем же tx", async () => {
    expect((await detectFlowVersion(scope)).useLatestFlowVersion).toBe(true)
    expect(active).toHaveBeenCalledWith({
      id: "2",
      workspaceId: "1",
      tx: actualTx,
    })
    expect(version).toHaveBeenCalledWith({
      versionId: "3",
      workspaceId: "1",
      tx: actualTx,
    })
  })
  test.each([
    "flowId",
    "workspaceId",
  ])("pinned версия с чужим %s запрещена", async (key) => {
    version.mockResolvedValue({ ...saved, [key]: "99" })
    await expect(
      detectFlowVersion({ ...scope, flowVersionId: "3" }),
    ).rejects.toThrow("FlowVersion not found")
  })
  test.each([
    "flowId",
    "workspaceId",
  ])("latest версия с чужим %s запрещена", async (key) => {
    version.mockResolvedValue({ ...saved, [key]: "99" })
    await expect(detectFlowVersion(scope)).rejects.toThrow(
      "FlowVersion not found",
    )
  })
  test.each([
    "source",
    "blocked",
  ])("%s gate не вызывает legacy loader", async (kind) => {
    boundary.mockRejectedValueOnce(new Error(`source_binding_denied:${kind}`))
    await expect(
      detectFlowVersion({ ...scope, flowVersionId: "3" }),
    ).rejects.toThrow("source_binding_denied")
    expect(boundary).toHaveBeenCalledWith(
      { ...scope, operation: "execute" },
      expect.any(Function),
    )
    expect(active).not.toHaveBeenCalled()
    expect(version).not.toHaveBeenCalled()
  })
})
