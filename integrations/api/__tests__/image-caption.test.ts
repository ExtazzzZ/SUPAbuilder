import {
  sendImageStepSchema,
  sendTextStepSchema,
} from "@chatbotx.io/flow-config"
import { expect, test, vi } from "vitest"

const { post } = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({ messageId: "1" }),
}))
vi.mock("../src/lib/delivery", () => ({ postSignedEnvelope: post }))
const { sendFlowStep } = await import(
  "../src/handlers/message/outgoing-message"
)

test("сохраняет подпись, формат и клавиатуру в одном сообщении с изображением", async () => {
  const step = sendImageStepSchema.parse({
    id: "1",
    stepType: "sendImage",
    mode: "url",
    url: "https://example.com/a.png",
    caption: "<b>Каталог</b>",
    textFormat: "html",
    buttons: [],
  })
  await sendFlowStep({
    ctx: {
      auth: {
        callbackUrl: "https://example.com/callback",
        signingSecret: "test",
      },
    },
    data: {
      contact: { id: "1", sourceId: "supacrm:bot:peer" },
      operationId: "caption-1",
      step,
      quickReplies: [
        { label: "Один", row: 0 },
        { label: "Два", row: 0 },
      ],
    },
  } as never)
  const message = post.mock.calls[0][0].envelope.message
  expect(message.text).toBe("<b>Каталог</b>")
  expect(message.contentAttributes).toEqual({
    textFormat: "html",
    attachments: [{ url: "https://example.com/a.png", fileType: "image" }],
  })
  expect(message.quickReplies.map((b: { row: number }) => b.row)).toEqual([
    0, 0,
  ])
})

test("формат текста явный и обратно совместимый", () => {
  const old = { id: "1", stepType: "sendText", text: "<literal>", buttons: [] }
  expect(sendTextStepSchema.parse(old).textFormat).toBeUndefined()
  expect(
    sendTextStepSchema.parse({ ...old, textFormat: "html" }).textFormat,
  ).toBe("html")
  expect(
    sendTextStepSchema.safeParse({ ...old, textFormat: "markdown" }).success,
  ).toBe(false)
})
