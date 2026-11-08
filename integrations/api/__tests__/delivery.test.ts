import { beforeEach, expect, test, vi } from "vitest"

const { post, assertPublicUrl, sign } = vi.hoisted(() => ({
  post: vi.fn(),
  assertPublicUrl: vi.fn(),
  sign: vi.fn(),
}))
vi.mock("ky", () => ({ default: { post } }))
vi.mock("@chatbotx.io/business", () => ({ assertPublicUrl }))
vi.mock("../src/lib/signature", () => ({ signApiPayload: sign }))
const { postSignedEnvelope } = await import("../src/lib/delivery")
beforeEach(() => {
  vi.clearAllMocks()
  post.mockResolvedValue({ text: async () => "" })
  sign.mockResolvedValue("signed")
})
test("trace timeout keeps the existing HMAC headers and public callback validation", async () => {
  const envelope = { event: "execution.trace", operationId: "trace" }
  await postSignedEnvelope({
    callbackUrl: "https://example.com/cb",
    signingSecret: "secret",
    envelope,
    timeoutMs: 500,
    retry: 0,
  })
  expect(assertPublicUrl).toHaveBeenCalledWith(
    "https://example.com/cb",
    "API channel callback URL",
  )
  const options = post.mock.calls[0][1]
  expect(options).toMatchObject({
    body: JSON.stringify(envelope),
    timeout: 500,
    retry: 0,
    headers: {
      "X-ChatbotX-Signature": "sha256=signed",
      "X-ChatbotX-Timestamp": expect.any(String),
      "X-ChatbotX-Delivery": expect.any(String),
    },
  })
  expect(sign).toHaveBeenCalledWith(
    "secret",
    options.headers["X-ChatbotX-Timestamp"],
    options.body,
  )
})
test("message delivery keeps its original timeout and retry defaults", async () => {
  await postSignedEnvelope({
    callbackUrl: "https://example.com/cb",
    signingSecret: "secret",
    envelope: {},
  })
  expect(post.mock.calls[0][1].timeout).toBe(30_000)
  expect(post.mock.calls[0][1]).not.toHaveProperty("retry")
})
