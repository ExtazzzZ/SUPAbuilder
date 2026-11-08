// @vitest-environment node

import {
  sendMessageNodeDefaultFn,
  sendVideoStepDefaultFn,
} from "@chatbotx.io/flow-config"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const {
  mockWithLegacyFlow,
  mockFreshVersion,
  mockCreateId,
  mockDbTransaction,
  mockFlowFindFirst,
  mockTxInsert,
  mockTxInsertValues,
  mockTxUpdate,
  mockTxSet,
  mockInvalidateCacheTags,
  mockDispatchAuditRecord,
  mockCancelStale,
  mockClearStale,
  mockLoggerWarn,
  mockEnqueueSync,
} = vi.hoisted(() => {
  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined)
  const mockTxInsert = vi.fn().mockReturnValue({ values: mockTxInsertValues })
  const mockTxWhere = vi.fn().mockResolvedValue(undefined)
  const mockTxSet = vi.fn().mockReturnValue({ where: mockTxWhere })
  const mockTxUpdate = vi.fn().mockReturnValue({ set: mockTxSet })

  return {
    mockWithLegacyFlow: vi.fn(),
    mockFreshVersion: vi.fn(),
    mockCreateId: vi.fn(),
    mockDbTransaction: vi.fn(),
    mockFlowFindFirst: vi.fn(),
    mockTxInsert,
    mockTxInsertValues,
    mockTxUpdate,
    mockTxSet,
    mockInvalidateCacheTags: vi.fn().mockResolvedValue(undefined),
    mockDispatchAuditRecord: vi.fn().mockResolvedValue(undefined),
    mockCancelStale: vi.fn().mockResolvedValue(0),
    mockClearStale: vi.fn().mockResolvedValue(0),
    mockLoggerWarn: vi.fn(),
    mockEnqueueSync: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    query: {
      flowModel: {
        findFirst: vi.fn(() => {
          throw new Error("Чтение Flow вне транзакции владельца")
        }),
      },
    },
    transaction: mockDbTransaction,
    update: mockTxUpdate,
  },
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
}))

vi.mock("@chatbotx.io/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/database/schema")>()),
  flowModel: { id: "flowModel.id" },
  flowVersionModel: {
    id: "flowVersionModel.id",
    flowId: "flowVersionModel.flowId",
    isLatest: "flowVersionModel.isLatest",
  },
}))

vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  withCache: (_key: string, fn: () => Promise<unknown>): Promise<unknown> =>
    fn(),
  invalidateCacheByTags: mockInvalidateCacheTags,
}))

vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/utils")>()),
  createId: mockCreateId,
}))

vi.mock("../src/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/errors")>()),
  notFoundException: (message: string) => new Error(message),
}))

vi.mock("../src/smart-delay/service", () => ({
  smartDelayService: {
    cancelQuickReplyFollowUpsForStaleVersion: mockCancelStale,
  },
}))

vi.mock("../src/conversation/service", () => ({
  conversationService: {
    clearQuickReplyChallengesForStaleVersion: mockClearStale,
  },
}))

vi.mock("../src/logger", () => ({
  logger: { warn: mockLoggerWarn },
}))

vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: mockDispatchAuditRecord,
}))

vi.mock("../src/messenger-welcome-message-flow/service", () => ({
  messengerWelcomeMessageFlowService: { enqueueSync: mockEnqueueSync },
}))

const transaction = {
  query: {
    flowModel: { findFirst: mockFlowFindFirst },
    flowVersionModel: { findFirst: mockFreshVersion },
  },
  insert: mockTxInsert,
  update: mockTxUpdate,
}
vi.mock("../src/supacrm-source-binding/service", () => ({
  supacrmSourceBindingService: { withLegacyFlow: mockWithLegacyFlow },
}))
beforeEach(() => {
  mockCreateId.mockReset()
  mockDbTransaction.mockReset().mockImplementation((work) => work(transaction))
  mockFreshVersion.mockReset()
  mockWithLegacyFlow
    .mockReset()
    .mockImplementation((_scope, work, tx) =>
      tx ? work(tx) : mockDbTransaction(work),
    )
})

const { flowVersionService } = await import("../src/flow-version/service")

describe("flowVersionService.publish", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test("resets other latest versions, syncs the draft, inserts the published version, repoints currentVersionId, invalidates cache, and audits", async () => {
    mockFlowFindFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      flowVersions: [
        { id: "draft-1", startNodeId: "node-1", nodes: [], edges: [] },
      ],
    })
    mockCreateId
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("2")
      // quickReplySettings followUp/retry ids in the node defaults
      .mockReturnValueOnce("3")
      .mockReturnValueOnce("4")
      .mockReturnValue("new-version-1")
    mockDbTransaction.mockImplementation(
      async (
        fn: (tx: {
          insert: typeof mockTxInsert
          update: typeof mockTxUpdate
        }) => Promise<unknown>,
      ) => fn(transaction),
    )

    const nodes = [sendMessageNodeDefaultFn({})]
    await flowVersionService.publish({
      workspaceId: "ws-1",
      flowId: "flow-1",
      nodes,
      edges: [],
    })

    expect(mockWithLegacyFlow).toHaveBeenCalledWith(
      { workspaceId: "ws-1", flowId: "flow-1", operation: "publish" },
      expect.any(Function),
    )
    // 1) reset other latest versions
    expect(mockTxUpdate).toHaveBeenNthCalledWith(1, {
      id: "flowVersionModel.id",
      flowId: "flowVersionModel.flowId",
      isLatest: "flowVersionModel.isLatest",
    })
    expect(mockTxSet).toHaveBeenNthCalledWith(1, { isLatest: false })

    // 2) sync draft nodes/edges
    expect(mockTxSet).toHaveBeenNthCalledWith(2, {
      nodes,
      edges: [],
    })

    // 3) insert new published version
    expect(mockTxInsert).toHaveBeenCalledWith({
      id: "flowVersionModel.id",
      flowId: "flowVersionModel.flowId",
      isLatest: "flowVersionModel.isLatest",
    })
    expect(mockTxInsertValues).toHaveBeenCalledWith({
      id: "new-version-1",
      workspaceId: "ws-1",
      flowId: "flow-1",
      isDraft: false,
      isLatest: true,
      nodes,
      edges: [],
      startNodeId: "node-1",
    })

    // 4) repoint currentVersionId
    expect(mockTxSet).toHaveBeenNthCalledWith(3, {
      currentVersionId: "new-version-1",
    })

    expect(mockInvalidateCacheTags).toHaveBeenCalledWith([
      "flows:flow-1:versions",
    ])
    expect(mockDispatchAuditRecord).toHaveBeenCalledWith({
      action: "publish",
      detail: "published a flow (#flow-1)",
    })
  })

  test("enqueues a welcome message flow sync after the transaction commits", async () => {
    mockFlowFindFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      flowVersions: [
        { id: "draft-1", startNodeId: "node-1", nodes: [], edges: [] },
      ],
    })
    mockCreateId
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("2")
      .mockReturnValueOnce("3")
      .mockReturnValueOnce("4")
      .mockReturnValue("5")
    mockDbTransaction.mockImplementation(
      async (
        fn: (tx: {
          insert: typeof mockTxInsert
          update: typeof mockTxUpdate
        }) => Promise<unknown>,
      ) => fn(transaction),
    )

    await flowVersionService.publish({
      workspaceId: "ws-1",
      flowId: "flow-1",
      nodes: [sendMessageNodeDefaultFn({})],
      edges: [],
    })

    expect(mockEnqueueSync).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      flowId: "flow-1",
      reason: "publish",
    })
    expect(mockDbTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnqueueSync.mock.invocationCallOrder[0],
    )
  })

  test("rejects a channel-incompatible graph before reading or mutating the flow", async () => {
    mockCreateId.mockReturnValue("1")
    const node = sendMessageNodeDefaultFn({})
    node.data.details.beforeStep.channel = "tiktok"
    node.data.details.steps = [sendVideoStepDefaultFn()]

    await expect(
      flowVersionService.publish({
        workspaceId: "ws-1",
        flowId: "flow-1",
        nodes: [node],
        edges: [],
      }),
    ).rejects.toMatchObject({ name: "FlowAuthoringException" })

    expect(mockFlowFindFirst).not.toHaveBeenCalled()
    expect(mockDbTransaction).not.toHaveBeenCalled()
  })

  test("rejects an incompatible restored graph before opening a transaction", async () => {
    mockCreateId.mockReturnValue("1")
    const node = sendMessageNodeDefaultFn({})
    node.data.details.beforeStep.channel = "tiktok"
    node.data.details.steps = [sendVideoStepDefaultFn()]

    await expect(
      flowVersionService.restore({
        version: { edges: [], nodes: [node] } as never,
      }),
    ).rejects.toMatchObject({ name: "FlowAuthoringException" })

    expect(mockDbTransaction).not.toHaveBeenCalled()
  })

  test("restore enqueues a welcome message flow sync for the restored version", async () => {
    mockCreateId
      .mockReturnValueOnce("1")
      .mockReturnValueOnce("2")
      .mockReturnValueOnce("3")
      .mockReturnValueOnce("4")
      .mockReturnValue("5")
    mockDbTransaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(transaction),
    )

    const savedVersion = {
      id: "9",
      flowId: "flow-1",
      workspaceId: "ws-1",
      nodes: [sendMessageNodeDefaultFn({})],
      edges: [],
      startNodeId: "1",
    } as never
    mockFreshVersion.mockResolvedValue(savedVersion)
    await flowVersionService.restore({ version: savedVersion })
    expect(mockFreshVersion).toHaveBeenCalledWith({
      where: {
        id: "9",
        flowId: "flow-1",
        workspaceId: "ws-1",
        isDraft: false,
      },
    })
    expect(mockWithLegacyFlow).toHaveBeenCalledWith(
      { workspaceId: "ws-1", flowId: "flow-1", operation: "restore" },
      expect.any(Function),
    )

    expect(mockEnqueueSync).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      flowId: "flow-1",
      reason: "publish",
    })
    expect(mockDbTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnqueueSync.mock.invocationCallOrder[0],
    )
  })

  test("clears stale quick reply state for the new version without failing publish when cleanup rejects", async () => {
    mockFlowFindFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      flowVersions: [
        { id: "draft-1", startNodeId: "node-1", nodes: [], edges: [] },
      ],
    })
    mockCreateId.mockReturnValue("new-version-1")
    mockDbTransaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(transaction),
    )
    mockCancelStale.mockRejectedValueOnce(new Error("boom"))

    await flowVersionService.publish({
      workspaceId: "ws-1",
      flowId: "flow-1",
      nodes: [] as never,
      edges: [] as never,
    })
    await vi.waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled())

    const expected = {
      workspaceId: "ws-1",
      flowId: "flow-1",
      currentFlowVersionId: "new-version-1",
    }
    expect(mockCancelStale).toHaveBeenCalledWith(expected)
    expect(mockClearStale).toHaveBeenCalledWith(expected)
    expect(mockLoggerWarn.mock.calls[0][0]).toMatchObject({ flowId: "flow-1" })
  })

  test("throws notFoundException when the flow does not exist", async () => {
    mockFlowFindFirst.mockResolvedValue(undefined)

    await expect(
      flowVersionService.publish({
        workspaceId: "ws-1",
        flowId: "missing",
        nodes: [] as never,
        edges: [] as never,
      }),
    ).rejects.toThrow("Flow not found")

    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })

  test("throws notFoundException when the flow has no draft version", async () => {
    mockFlowFindFirst.mockResolvedValue({
      id: "flow-1",
      workspaceId: "ws-1",
      flowVersions: [],
    })

    await expect(
      flowVersionService.publish({
        workspaceId: "ws-1",
        flowId: "flow-1",
        nodes: [] as never,
        edges: [] as never,
      }),
    ).rejects.toThrow("Flow not found")

    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
  })
})

describe("flowVersionService.updateDraftByFlowId", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test("saves an in-progress graph without publish validation", async () => {
    vi.spyOn(flowVersionService, "findDraft").mockResolvedValue({
      id: "draft-1",
      nodes: [],
      edges: [],
    } as never)

    await expect(
      flowVersionService.updateDraftByFlowId({
        workspaceId: "ws-1",
        flowId: "flow-1",
        nodes: [{ id: "unsupported-node" }] as never,
        edges: [] as never,
      }),
    ).resolves.toBeUndefined()
    expect(mockWithLegacyFlow).toHaveBeenCalledWith(
      { workspaceId: "ws-1", flowId: "flow-1", operation: "updateDraft" },
      expect.any(Function),
    )
    expect(flowVersionService.findDraft).toHaveBeenCalledWith(
      { flowId: "flow-1", workspaceId: "ws-1" },
      transaction,
    )
  })
})

describe("Подключение guard к publish и restore", () => {
  afterEach(() => vi.clearAllMocks())
  test.each([
    "publish",
    "restore",
    "updateDraft",
  ])("DENY %s запрещает записи и внешнюю синхронизацию", async (operation) => {
    mockWithLegacyFlow.mockRejectedValueOnce(new Error("source_binding_denied"))
    let call: Promise<unknown>
    if (operation === "publish") {
      call = flowVersionService.publish({
        workspaceId: "ws-1",
        flowId: "flow-1",
        nodes: [],
        edges: [],
      })
    } else if (operation === "restore") {
      call = flowVersionService.restore({
        version: {
          id: "9",
          workspaceId: "ws-1",
          flowId: "flow-1",
          nodes: [],
          edges: [],
        } as never,
      })
    } else {
      call = flowVersionService.updateDraftByFlowId({
        workspaceId: "ws-1",
        flowId: "flow-1",
        nodes: [],
        edges: [],
      })
    }
    await expect(call).rejects.toThrow("source_binding_denied")
    expect(mockWithLegacyFlow).toHaveBeenCalledWith(
      { workspaceId: "ws-1", flowId: "flow-1", operation },
      expect.any(Function),
    )
    expect(mockDbTransaction).not.toHaveBeenCalled()
    expect(mockTxInsert).not.toHaveBeenCalled()
    expect(mockTxUpdate).not.toHaveBeenCalled()
    expect(mockEnqueueSync).not.toHaveBeenCalled()
  })
  test("restore использует сохранённую строку под lock вместо графа caller", async () => {
    mockCreateId.mockReturnValue("1")
    const saved = {
      id: "9",
      flowId: "flow-1",
      workspaceId: "ws-1",
      nodes: [sendMessageNodeDefaultFn({})],
      edges: [],
      startNodeId: "saved-node",
    }
    mockFreshVersion.mockResolvedValue(saved)
    await flowVersionService.restore({
      version: { ...saved, nodes: [], startNodeId: "stale-node" } as never,
    })
    expect(mockTxSet).toHaveBeenNthCalledWith(4, {
      nodes: saved.nodes,
      edges: saved.edges,
      startNodeId: "saved-node",
    })
  })
  test("Отсутствующая под lock версия запрещает изменение draft и публикацию", async () => {
    mockFreshVersion.mockResolvedValue(undefined)
    await expect(
      flowVersionService.restore({
        version: {
          id: "9",
          workspaceId: "ws-1",
          flowId: "flow-1",
          nodes: [],
          edges: [],
        } as never,
      }),
    ).rejects.toThrow("Flow version not found")
    expect(mockTxUpdate).not.toHaveBeenCalled()
    expect(mockEnqueueSync).not.toHaveBeenCalled()
  })
})
