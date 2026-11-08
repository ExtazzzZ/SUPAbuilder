import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockPostSignedEnvelope } = vi.hoisted(() => ({
  mockPostSignedEnvelope: vi.fn(),
}))

vi.mock("../src/lib/delivery", () => ({
  postSignedEnvelope: mockPostSignedEnvelope,
}))

const { sendFlowStep, handleMessageStatus } = await import(
  "../src/handlers/message/outgoing-message"
)

const ctx = {
  auth: {
    callbackUrl: "https://example.com/callback",
    signingSecret: "secret",
  },
} as never

const contact = { id: "contact-1", sourceId: "source-1" } as never

describe("api sendFlowStep — sendMultipleImages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "m_1" })
  })

  test("maps every image into contentAttributes.attachments instead of degrading to text", async () => {
    const result = await sendFlowStep({
      ctx,
      data: {
        contact,
        operationId: "operation-1",
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "sendMultipleImages",
          images: [
            { id: "img-1", mode: "url", url: "https://example.com/a.png" },
            { id: "img-2", mode: "url", url: "https://example.com/b.png" },
            { id: "img-3", mode: "url", url: "https://example.com/c.png" },
          ],
        },
      },
    } as never)

    expect(mockPostSignedEnvelope).toHaveBeenCalledTimes(1)
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBeNull()
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [
        { url: "https://example.com/a.png", fileType: "image" },
        { url: "https://example.com/b.png", fileType: "image" },
        { url: "https://example.com/c.png", fileType: "image" },
      ],
    })
    expect(result).toEqual({ messageIds: ["m_1"], sentCount: 1 })
  })

  test("rejects an unsupported card instead of degrading it to an empty message", async () => {
    await expect(
      sendFlowStep({
        ctx,
        data: {
          contact,
          operationId: "operation-1",
          quickReplies: [],
          step: {
            id: "step-card-1",
            nodeId: "node-1",
            stepType: "sendCard",
            buttons: [],
            title: "Unsupported card",
          },
        },
      } as never),
    ).rejects.toThrow("Unsupported API flow step: sendCard")

    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
  })
})

describe("API callback operation identity", () => {
  const props = {
    ctx,
    data: {
      contact,
      operationId: "operation-retry",
      step: { id: "1", stepType: "sendText", text: "same text", buttons: [] },
    },
  } as never
  test("replays the logical ID and rejects missing identity before HTTP", async () => {
    vi.clearAllMocks()
    await sendFlowStep(props)
    await sendFlowStep(props)
    for (const [args] of mockPostSignedEnvelope.mock.calls) {
      expect(args.envelope.operationId).toBe("operation-retry")
      expect(args.envelope.message.id).toBe("operation-retry")
    }
    vi.clearAllMocks()
    await expect(
      sendFlowStep({
        ctx,
        data: {
          contact,
          step: { id: "1", stepType: "sendText", text: "same text" },
        },
      } as never),
    ).rejects.toThrow("stable operationId")
    expect(mockPostSignedEnvelope).not.toHaveBeenCalled()
  })
})

test("delivery status accepts the documented public messageId and legacy alias", async () => {
  for (const id of [
    { messageId: "outbox-1" },
    { messageSourceId: "outbox-1" },
  ]) {
    const result = await handleMessageStatus({
      data: { payload: { ...id, status: "delivered" } },
    } as never)
    expect(result?.message?.sourceId).toBe("outbox-1")
  }
  expect(() =>
    handleMessageStatus({
      data: { payload: { status: "delivered" } },
    } as never),
  ).toThrow("message ID")
})

test("возвращает явную причину в callback только для SUPAcrm", async () => {
  for (const sourceId of ["supacrm:bot:peer", "other:peer"]) {
    vi.clearAllMocks()
    await sendFlowStep({
      ctx,
      data: {
        contact: { id: "contact-1", sourceId },
        operationId: "op-42",
        crmNavigation: {
          sourceEventId: "event-42",
          updateMode: "edit_previous",
        },
        step: {
          id: "1",
          stepType: "sendImage",
          url: "https://example.com/a.png",
        },
      },
    } as never)
    const attrs =
      mockPostSignedEnvelope.mock.calls[0][0].envelope.message.contentAttributes
    expect(attrs.attachments).toHaveLength(1)
    expect(attrs.crmNavigation).toEqual(
      sourceId.startsWith("supacrm:")
        ? { sourceEventId: "event-42", updateMode: "edit_previous" }
        : undefined,
    )
  }
})

test("сохраняет строки кнопок в подписанном callback API-канала", async () => {
  vi.clearAllMocks()
  const quickReplies = [
    {
      id: "1",
      label: "Первая",
      buttonType: "postback",
      postback: "payload-1",
      row: 0,
    },
    {
      id: "2",
      label: "Вторая",
      buttonType: "url",
      url: "https://example.com",
      row: 0,
    },
    { id: "3", label: "Назад", buttonType: "postback", postback: "payload-3" },
  ]
  await sendFlowStep({
    ctx,
    data: {
      contact,
      operationId: "rows-1",
      quickReplies,
      step: { id: "1", stepType: "sendText", text: "Меню", buttons: [] },
    },
  } as never)
  expect(
    mockPostSignedEnvelope.mock.calls[0]?.[0].envelope.message.quickReplies,
  ).toEqual(quickReplies)
})

test("plain terminal сохраняет явный send_new до подписанного callback", async () => {
  vi.clearAllMocks()
  const crmNavigation = {
    sourceEventId: "resume-event-42",
    updateMode: "send_new",
  }
  await sendFlowStep({
    ctx,
    data: {
      contact: { id: "contact-1", sourceId: "supacrm:bot:peer" },
      operationId: "terminal-42",
      crmNavigation,
      quickReplies: [],
      step: {
        id: "step-1",
        stepType: "sendText",
        text: "Оплата подтверждена",
        buttons: [],
      },
    },
  } as never)
  expect(mockPostSignedEnvelope).toHaveBeenCalledOnce()
  const { envelope } = mockPostSignedEnvelope.mock.calls[0][0]
  expect(envelope.message.text).toBe("Оплата подтверждена")
  expect(envelope.message.quickReplies).toEqual([])
  expect(envelope.message.contentAttributes.crmNavigation).toEqual(
    crmNavigation,
  )
})
