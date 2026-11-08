import { beforeEach, expect, test, vi } from "vitest"

const {
  mockResolveOwner,
  mockBuildContext,
  mockCreateMessageRepository,
  mockEmit,
  mockFindConversation,
  mockFindContactInbox,
  mockIdentifyIntegration,
  mockLoggerWarn,
  mockMarkReadByContact,
  mockRunChannelHandler,
} = vi.hoisted(() => ({
  mockResolveOwner: vi.fn(),
  mockBuildContext: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  mockCreateMessageRepository: vi.fn().mockResolvedValue({
    findBySourceId: vi.fn().mockResolvedValue(null),
  }),
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockFindConversation: vi.fn(),
  mockFindContactInbox: vi.fn(),
  mockIdentifyIntegration: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockMarkReadByContact: vi.fn().mockResolvedValue(undefined),
  mockRunChannelHandler: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  buildContext: mockBuildContext,
  messageService: { resolveApiStatusOwner: mockResolveOwner },
  contactInboxService: {
    findByUncached: mockFindContactInbox,
  },
  conversationService: {
    findDMByContact: mockFindConversation,
    markReadByContact: mockMarkReadByContact,
  },
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: mockCreateMessageRepository,
  findConversationById: mockFindConversation,
  getSafeSinceTime: vi.fn((date: Date | null) => date ?? new Date(0)),
  contactInboxRepository: {
    findWithContact: mockFindContactInbox,
    findWithConversationAndContact: mockFindContactInbox,
  },
}))

vi.mock("@chatbotx.io/event-bus", () => ({
  emit: mockEmit,
}))

vi.mock("@chatbotx.io/sdk", () => ({
  SdkException: class SdkException extends Error {},
  // Mirror of the real pure helper — the module is fully mocked here.
  resolveSourceScopedIdentityMatch: async <T>(
    identity: { sourceId: string; sourceUserId?: string | null },
    lookup: (
      where: { sourceId: string } | { sourceUserId: string },
    ) => Promise<T | undefined>,
  ) => {
    const bySourceId = await lookup({ sourceId: identity.sourceId })
    if (bySourceId || !identity.sourceUserId) {
      return bySourceId
        ? { row: bySourceId, matchedBy: "sourceId" as const }
        : undefined
    }
    const bySourceUserId = await lookup({
      sourceUserId: identity.sourceUserId,
    })
    return bySourceUserId
      ? { row: bySourceUserId, matchedBy: "sourceUserId" as const }
      : undefined
  },
}))

vi.mock("@chatbotx.io/flow-config", () => ({
  BUTTON_LABEL_MAX: 20,
  messageEventTypeSchema: {
    enum: {
      "message:delivered": "message:delivered",
      "message:failed": "message:failed",
      "message:received": "message:received",
      "message:seen": "message:seen",
    },
  },
  UPDATE_STATUS_PAYLOAD_TYPE: "update_status",
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: { messageStatus: "messageStatus" },
}))

vi.mock("../src/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: mockLoggerWarn,
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock("../src/services/integrations", () => ({
  allIntegrations: {
    api: { runChannelHandler: mockRunChannelHandler },
    messenger: { runChannelHandler: mockRunChannelHandler },
    whatsapp: { runChannelHandler: mockRunChannelHandler },
  },
  integrationService: {
    identifyInboxAndIntegrationAuthFromIdentifier: mockIdentifyIntegration,
  },
}))

vi.mock("../src/integration/handlers/flow", () => ({
  runFlowPostback: vi.fn(),
}))

const { handleMessageStatus } = await import(
  "../src/integration/handlers/message-status"
)
const owner = {
  message: {
    id: "native-message",
    sourceId: "crm-job",
    conversationId: "conv",
    createdAt: new Date(0),
    contentAttributes: {},
  },
  contactInbox: {
    id: "ci",
    inboxId: "inbox",
    contactId: "contact",
    sourceId: "source",
    conversation: { id: "conv", workspaceId: "ws", contactId: "contact" },
    contact: { id: "contact", workspaceId: "ws" },
  },
}
const status = (value = "delivered") => ({
  integrationType: "api",
  integrationIdentifier: "inbox",
  payload: {
    messageId: "crm-job",
    status: value,
    timestamp: "2026-11-06T00:00:00+00:00",
  },
})
beforeEach(() => {
  vi.clearAllMocks()
  mockIdentifyIntegration.mockResolvedValue({
    inbox: { id: "inbox", workspaceId: "ws", channel: "api" },
    integrationRow: { enabled: true, inboxId: "inbox", workspaceId: "ws" },
  })
  mockRunChannelHandler.mockResolvedValue({ contact: { sourceId: "" } })
  mockResolveOwner.mockResolvedValue(owner)
})
test.each([
  "delivered",
  "failed",
  "read",
])("%s always carries owning Message and stable ISO timestamp", async (value) => {
  await handleMessageStatus(status(value))
  expect(mockResolveOwner).toHaveBeenCalledWith({
    workspaceId: "ws",
    inboxId: "inbox",
    sourceId: "crm-job",
  })
  const event = value === "read" ? "message:seen" : `message:${value}`
  expect(mockEmit).toHaveBeenCalledWith(
    event,
    expect.objectContaining({
      action: expect.objectContaining({ messageId: "native-message" }),
      context: expect.objectContaining({
        workspaceId: "ws",
        contactId: "contact",
        conversationId: "conv",
        contactInboxId: "ci",
      }),
      occurredAt: new Date("2026-11-06T00:00:00Z"),
    }),
  )
  expect(mockFindContactInbox).not.toHaveBeenCalled()
  if (value !== "read") {
    expect(mockMarkReadByContact).not.toHaveBeenCalled()
  }
})
test.each([
  "pending",
  "ambiguous",
  "mismatch",
  "limit",
])("owner %s has zero side effects", async (reason) => {
  mockResolveOwner.mockRejectedValueOnce(
    new Error(`api_status_owner_${reason}`),
  )
  await expect(handleMessageStatus(status("read"))).rejects.toThrow(
    `api_status_owner_${reason}`,
  )
  expect(mockEmit).not.toHaveBeenCalled()
  expect(mockMarkReadByContact).not.toHaveBeenCalled()
})
test("disabled or foreign API auth fails before resolution", async () => {
  mockIdentifyIntegration.mockResolvedValueOnce({
    inbox: { id: "inbox", workspaceId: "ws", channel: "api" },
    integrationRow: { enabled: false, inboxId: "inbox", workspaceId: "ws" },
  })
  await expect(handleMessageStatus(status())).rejects.toThrow(
    "api_status_auth_mismatch",
  )
  expect(mockResolveOwner).not.toHaveBeenCalled()
  expect(mockEmit).not.toHaveBeenCalled()
})
test("invalid API timestamp never emits or marks read", async () => {
  const job = status("read")
  job.payload.timestamp = "not-a-date"
  await expect(handleMessageStatus(job)).rejects.toThrow(
    "api_status_timestamp_invalid",
  )
  expect(mockMarkReadByContact).not.toHaveBeenCalled()
  expect(mockEmit).not.toHaveBeenCalled()
})

test.skipIf(!process.env.STAGE6A_REDIS_PORT)(
  "real BullMQ: persistence barrier, retained duplicates, independent statuses, exhausted miss",
  async () => {
    const { Queue, QueueEvents, Worker } = await import("bullmq")
    const { deliveryStatusJobOptions } = await import(
      "../../builder/src/features/integration-api/lib/delivery-status-job"
    )
    const connection = {
      host: "127.0.0.1",
      port: Number(process.env.STAGE6A_REDIS_PORT),
      maxRetriesPerRequest: null,
    }
    const name = `stage6a-${crypto.randomUUID()}`
    const queue = new Queue(name, { connection })
    const events = new QueueEvents(name, { connection })
    let persisted = false
    let initialPending: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      initialPending = resolve
    })
    const sender = vi.fn(() => {
      /* callback returns before sourceId persistence */
    })
    sender()
    mockResolveOwner.mockImplementation(() => {
      if (!persisted) {
        initialPending?.()
        throw new Error("api_status_owner_pending")
      }
      return Promise.resolve(owner)
    })
    const consumer = new Worker(
      name,
      async (job) => await handleMessageStatus(job.data),
      { connection },
    )
    try {
      await events.waitUntilReady()
      const data = status()
      const opts = await deliveryStatusJobOptions("inbox", data.payload)
      const job = await queue.add("messageStatus", data, opts)
      await barrier
      expect(mockEmit).not.toHaveBeenCalled()
      expect(mockMarkReadByContact).not.toHaveBeenCalled()
      persisted = true
      await job.waitUntilFinished(events, 15_000)
      expect((await queue.getJob(job.id as string))?.attemptsMade).toBe(2)
      expect(sender).toHaveBeenCalledTimes(1)
      const duplicate = await queue.add("messageStatus", data, opts)
      expect(duplicate.id).toBe(job.id)
      expect(await duplicate.getState()).toBe("completed")
      expect(
        mockEmit.mock.calls.filter(([event]) => event === "message:delivered"),
      ).toHaveLength(1)
      for (const value of ["failed", "read"]) {
        const item = status(value)
        const independent = await queue.add(
          "messageStatus",
          item,
          await deliveryStatusJobOptions("inbox", item.payload),
        )
        await independent.waitUntilFinished(events, 15_000)
      }
      expect(
        mockEmit.mock.calls.filter(([event]) => event === "message:failed"),
      ).toHaveLength(1)
      expect(
        mockEmit.mock.calls.filter(([event]) => event === "message:seen"),
      ).toHaveLength(1)
      persisted = false
      vi.clearAllMocks()
      mockResolveOwner.mockRejectedValue(new Error("api_status_owner_pending"))
      const missing = status()
      missing.payload.messageId = "permanent-miss"
      const missingOptions = await deliveryStatusJobOptions(
        "inbox",
        missing.payload,
      )
      const miss = await queue.add("messageStatus", missing, missingOptions)
      await expect(miss.waitUntilFinished(events, 15_000)).rejects.toThrow(
        "api_status_owner_pending",
      )
      const retained = await queue.getJob(miss.id as string)
      expect(retained?.attemptsMade).toBe(4)
      expect(await retained?.getState()).toBe("failed")
      const acceptedAgain = await queue.add(
        "messageStatus",
        missing,
        missingOptions,
      )
      expect(acceptedAgain.id).toBe(miss.id)
      expect(await acceptedAgain.getState()).toBe("failed")
      expect(mockEmit).not.toHaveBeenCalled()
      expect(mockMarkReadByContact).not.toHaveBeenCalled()
    } finally {
      await consumer.close()
      await events.close()
      await queue.close()
    }
  },
  30_000,
)

test.skipIf(!process.env.STAGE6A_REDIS_PORT)(
  "real BullMQ: status dedup survives unrelated count cleanup",
  async () => {
    const { Queue, QueueEvents, Worker } = await import("bullmq")
    const { deliveryStatusJobOptions } = await import(
      "../../builder/src/features/integration-api/lib/delivery-status-job"
    )
    const connection = {
      host: "127.0.0.1",
      port: Number(process.env.STAGE6A_REDIS_PORT),
      maxRetriesPerRequest: null,
    }
    const name = `stage6a-pressure-${crypto.randomUUID()}`
    const queue = new Queue(name, { connection })
    const events = new QueueEvents(name, { connection })
    const consumer = new Worker(
      name,
      async (job) => {
        if (job.name === "messageStatus") {
          await handleMessageStatus(job.data)
        }
      },
      { connection },
    )
    try {
      await events.waitUntilReady()
      const data = status()
      const opts = await deliveryStatusJobOptions("inbox", data.payload)
      const redis = await queue.client
      const key = queue.toKey(`de:${opts.jobId}`)
      await expect(
        queue.add("messageStatus", data, {
          ...opts,
          jobId: "bad:custom:id:format",
        }),
      ).rejects.toThrow()
      expect(await redis.exists(key)).toBe(0)
      const sender = vi.fn()
      sender()
      const original = await queue.add("messageStatus", data, opts)
      await original.waitUntilFinished(events, 5000)
      const initialTtl = await redis.pttl(key)
      expect(initialTtl).toBeGreaterThan(604_790_000)
      const cleanup = await queue.add(
        "unrelated",
        {},
        { removeOnComplete: { count: 1 } },
      )
      await cleanup.waitUntilFinished(events, 5000)
      expect(await queue.getJob(original.id as string)).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const accepted = await queue.add("messageStatus", data, opts)
      const duplicate = await queue.getJob(accepted.id as string)
      if (duplicate) {
        await duplicate.waitUntilFinished(events, 5000)
      }
      expect(accepted.id).toBe(original.id)
      expect(
        mockEmit.mock.calls.filter(([event]) => event === "message:delivered"),
      ).toHaveLength(1)
      expect(duplicate).toBeUndefined()
      expect(await redis.pttl(key)).toBeLessThan(initialTtl)
      expect(sender).toHaveBeenCalledTimes(1)
    } finally {
      await consumer.close()
      await events.close()
      await queue.close()
    }
  },
)

test.skipIf(!process.env.STAGE6A_REDIS_PORT)(
  "real BullMQ: failed status key survives unrelated count cleanup",
  async () => {
    const { Queue, QueueEvents, Worker } = await import("bullmq")
    const { deliveryStatusJobOptions } = await import(
      "../../builder/src/features/integration-api/lib/delivery-status-job"
    )
    const connection = {
      host: "127.0.0.1",
      port: Number(process.env.STAGE6A_REDIS_PORT),
      maxRetriesPerRequest: null,
    }
    const name = `stage6a-failed-pressure-${crypto.randomUUID()}`
    const queue = new Queue(name, { connection })
    const events = new QueueEvents(name, { connection })
    mockResolveOwner.mockRejectedValue(new Error("api_status_owner_mismatch"))
    const consumer = new Worker(
      name,
      async (job) => {
        if (job.name === "messageStatus") {
          await handleMessageStatus(job.data)
        } else {
          throw new Error("unrelated_failure")
        }
      },
      { connection },
    )
    try {
      await events.waitUntilReady()
      const data = status()
      const opts = await deliveryStatusJobOptions("inbox", data.payload)
      const original = await queue.add("messageStatus", data, opts)
      await expect(original.waitUntilFinished(events, 5000)).rejects.toThrow(
        "api_status_owner_mismatch",
      )
      expect((await queue.getJob(original.id as string))?.attemptsMade).toBe(1)
      const cleanup = await queue.add(
        "unrelated",
        {},
        { removeOnFail: { count: 1 } },
      )
      await expect(cleanup.waitUntilFinished(events, 5000)).rejects.toThrow(
        "unrelated_failure",
      )
      expect(await queue.getJob(original.id as string)).toBeUndefined()
      const accepted = await queue.add("messageStatus", data, opts)
      expect(accepted.id).toBe(original.id)
      expect(await queue.getJob(accepted.id as string)).toBeUndefined()
      expect(
        await (await queue.client).pttl(queue.toKey(`de:${opts.jobId}`)),
      ).toBeGreaterThan(604_790_000)
      expect(mockEmit).not.toHaveBeenCalled()
      expect(mockMarkReadByContact).not.toHaveBeenCalled()
    } finally {
      await consumer.close()
      await events.close()
      await queue.close()
    }
  },
)

test("declared crash-after-emit limitation: retry may emit delivered twice", async () => {
  mockEmit
    .mockImplementationOnce(async () => {
      /* event committed */
    })
    .mockImplementationOnce(() => {
      throw new Error("crash_after_delivered")
    })
  await expect(handleMessageStatus(status())).rejects.toThrow(
    "crash_after_delivered",
  )
  await handleMessageStatus(status())
  expect(
    mockEmit.mock.calls.filter(([event]) => event === "message:delivered"),
  ).toHaveLength(2)
})

test.each([
  undefined,
  { id: "other", workspaceId: "ws", contactId: "contact" },
  { id: "conv", workspaceId: "other", contactId: "contact" },
  { id: "conv", workspaceId: "ws", contactId: "other" },
])("exact Conversation mismatch %j has zero native effects", async (conversation) => {
  const { resolveApiStatusOwner } = await import(
    "../../../packages/business/src/message/resolve-api-status-owner"
  )
  mockResolveOwner.mockImplementation(resolveApiStatusOwner)
  mockCreateMessageRepository.mockResolvedValue({
    findStatusCandidates: vi.fn().mockResolvedValue([
      {
        ...owner.message,
        workspaceId: "ws",
        contactInboxId: "ci",
        messageType: "outgoing",
        deletedAt: null,
      },
    ]),
  })
  const { conversation: _ignored, ...contactInbox } = owner.contactInbox
  mockFindContactInbox.mockResolvedValue({ ...contactInbox, channel: "api" })
  mockFindConversation.mockResolvedValue(conversation)
  await expect(handleMessageStatus(status("read"))).rejects.toThrow(
    "api_status_owner_mismatch",
  )
  expect(mockFindConversation).toHaveBeenCalledWith({
    conversationId: "conv",
    workspaceId: "ws",
  })
  expect(mockEmit).not.toHaveBeenCalled()
  expect(mockMarkReadByContact).not.toHaveBeenCalled()
})
