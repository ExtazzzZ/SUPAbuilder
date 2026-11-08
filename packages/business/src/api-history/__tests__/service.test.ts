import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  resolveContact: vi.fn(),
  activity: vi.fn(),
  findOrCreate: vi.fn(),
  invalidate: vi.fn(),
  findBySourceId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  edit: vi.fn(),
  realtime: vi.fn(),
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: { transaction: mocks.transaction },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  resolveApiHistoryContact: mocks.resolveContact,
  recordApiHistoryActivity: mocks.activity,
  createMessageRepository: vi.fn(async () => ({
    findBySourceId: mocks.findBySourceId,
    createWithAttachments: mocks.create,
    updateContentAttributes: mocks.update,
    findById: mocks.findById,
  })),
}))
vi.mock("../../conversation/service", () => ({
  conversationService: {
    findOrCreate: mocks.findOrCreate,
    invalidate: mocks.invalidate,
  },
}))
vi.mock("../../message/service", () => ({
  messageService: { edit: mocks.edit },
}))
vi.mock("../../platform/realtime-broadcast", () => ({
  queueMessageCreatedEvent: mocks.realtime,
  queueWorkspaceRealtimeEvent: vi.fn(),
}))

import { apiHistorySchema } from "../schema"
import { projectApiHistory } from "../service"

const request = (revision = 0) => ({
  workspaceId: "10",
  inboxId: "20",
  input: apiHistorySchema.parse({
    contact: { sourceId: "supacrm:bot:peer" },
    message: {
      sourceId: "event-1",
      createdAt: "2026-11-03T10:00:00Z",
      direction: "outgoing",
      text: "Каталог",
      revision,
      platformMessageId: "tg-12",
      deliveryStatus: "delivered",
      attachments: [
        {
          url: "https://example.com/photo.jpg",
          fileType: "image",
          mimeType: "image/jpeg",
        },
      ],
      contentAttributes: { buttons: [{ text: "Открыть" }] },
    },
  }),
})
let stored: Record<string, unknown> | null
beforeEach(() => {
  vi.clearAllMocks()
  stored = null
  mocks.transaction.mockImplementation(async (fn) => await fn({}))
  mocks.resolveContact.mockResolvedValue({ id: "30", contactId: "40" })
  mocks.findOrCreate.mockResolvedValue({
    id: "50",
    createdAt: new Date("2026-11-03T09:00:00Z"),
  })
  mocks.findBySourceId.mockImplementation(
    (sourceId, _conversation, _workspace, sinceTime) => {
      // Реальный sharded repository отклоняет вызов без временной границы.
      expect(sinceTime).toEqual(new Date("2026-11-02T09:00:00Z"))
      return sourceId.startsWith("api-history:") ? stored : null
    },
  )
  mocks.create.mockImplementation((message, attachments) => {
    stored = { ...message, id: "60", attachments }
    return stored
  })
  mocks.update.mockImplementation(
    (_messageId, _workspaceId, contentAttributes) => {
      stored = { ...stored, contentAttributes }
    },
  )
  mocks.edit.mockImplementation((patch) => {
    stored = { ...stored, text: patch.text, attachments: patch.attachments }
  })
  mocks.findById.mockImplementation(async () => stored)
})

describe("Проекция истории API без исполнения bot-flow", () => {
  it("повтор события не создаёт сообщение, вложения или повторный realtime", async () => {
    expect(await projectApiHistory(request())).toEqual({
      accepted: true,
      changed: true,
      messageId: "60",
    })
    expect(await projectApiHistory(request())).toEqual({
      accepted: true,
      changed: false,
      messageId: "60",
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.realtime).toHaveBeenCalledTimes(1)
    expect(mocks.edit).not.toHaveBeenCalled()
    expect(mocks.activity).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][1][0]).toMatchObject({
      fileType: "image",
      originPath: "https://example.com/photo.jpg",
    })
  })

  it("правка сохраняет снимок, платформенный ID и не даёт устаревшей ревизии откатить текст", async () => {
    await projectApiHistory(request())
    const edit = request(2)
    edit.input.message.text = "Обновлённый каталог"
    edit.input.message.platformMessageId = undefined
    await projectApiHistory(edit)
    await projectApiHistory(request(1))
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.edit).toHaveBeenCalledTimes(1)
    expect(stored).toMatchObject({
      text: "Обновлённый каталог",
      contentAttributes: {
        apiHistory: {
          revision: 2,
          platformMessageId: "tg-12",
          snapshots: [
            { revision: 0, text: "Каталог", platformMessageId: "tg-12" },
          ],
        },
      },
    })
  })

  it("запрещает менять направление и время исходного сообщения", async () => {
    await projectApiHistory(request())
    const edit = request(1)
    edit.input.message.direction = "incoming"
    await expect(projectApiHistory(edit)).rejects.toThrow("направлению")
    expect(mocks.edit).not.toHaveBeenCalled()
  })

  it("разделяет одинаковые внешние IDs разных контактов и inbox", async () => {
    await projectApiHistory(request())
    const first = mocks.findBySourceId.mock.calls[1][0]
    const next = request()
    next.input.contact.sourceId = "supacrm:other:peer"
    stored = null
    await projectApiHistory(next)
    expect(mocks.findBySourceId.mock.calls[3][0]).not.toBe(first)
    expect(mocks.resolveContact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "10",
        inboxId: "20",
        sourceId: "supacrm:other:peer",
      }),
    )
  })

  it("удаление сохраняет предыдущий текст в аудите, очищая текущие вложения", async () => {
    await projectApiHistory(request())
    const removed = request(1)
    removed.input.message.deleted = true
    await projectApiHistory(removed)
    expect(stored).toMatchObject({
      text: "Сообщение удалено",
      attachments: [],
      contentAttributes: {
        apiHistory: { deleted: true, snapshots: [{ text: "Каталог" }] },
      },
    })
  })
  it("не меняет уже подтверждённый платформенный ID", async () => {
    await projectApiHistory(request())
    const edit = request(1)
    edit.input.message.platformMessageId = "other-message"
    await expect(projectApiHistory(edit)).rejects.toThrow("Платформенный ID")
    expect(mocks.edit).not.toHaveBeenCalled()
  })
  it("принимает существующее обычное сообщение вместо дубликата и сохраняет исходный маркер", async () => {
    const base = request()
    stored = {
      ...base.input.message,
      id: "native-id",
      contactInboxId: "30",
      messageType: "outgoing",
      createdAt: new Date("2026-11-03T10:00:05Z"),
      text: "SUPACRM_ACTION_V1...",
      contentAttributes: {},
    }
    mocks.findBySourceId.mockImplementation(async (sourceId) =>
      sourceId === "event-1" ? stored : null,
    )
    expect(await projectApiHistory(base)).toEqual({
      accepted: true,
      changed: true,
      messageId: "native-id",
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(stored).toMatchObject({
      text: "Каталог",
      contentAttributes: {
        apiHistory: { snapshots: [{ text: "SUPACRM_ACTION_V1..." }] },
      },
    })
  })

  it("ожидает обычную запись без создания дубля, когда назначение sourceId запаздывает", async () => {
    const base = request()
    base.input.message.requireExisting = true
    await expect(projectApiHistory(base)).rejects.toThrow("ещё не появилось")
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.edit).not.toHaveBeenCalled()
  })
  it("не принимает обычную запись другого inbox даже при совпадении sourceId", async () => {
    mocks.findBySourceId.mockImplementation(async (sourceId) =>
      sourceId === "event-1"
        ? {
            id: "foreign",
            contactInboxId: "another-inbox",
            messageType: "outgoing",
            createdAt: new Date("2026-11-03T10:00:00Z"),
            contentAttributes: {},
          }
        : null,
    )
    const base = request()
    base.input.message.requireExisting = true
    await expect(projectApiHistory(base)).rejects.toThrow("ещё не появилось")
    expect(mocks.edit).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
