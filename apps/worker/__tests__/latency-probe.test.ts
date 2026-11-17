import { afterEach, beforeEach, expect, test, vi } from "vitest"

const { post, info, resolve } = vi.hoisted(() => ({
  post: vi.fn(),
  info: vi.fn(),
  resolve: vi.fn(),
}))
vi.mock("ky", () => ({ default: { post } }))
vi.mock("@chatbotx.io/business", () => ({ assertPublicUrl: vi.fn() }))
vi.mock("../../../integrations/api/src/lib/signature", () => ({
  signApiPayload: vi.fn(async () => "synthetic"),
}))
vi.mock("../src/services/integrations", () => ({
  resolveIntegrationContextFromContactInbox: resolve,
}))
vi.mock("../src/lib/logger", () => ({ logger: { info, warn: vi.fn() } }))
vi.mock(
  "@chatbotx.io/integration-api/lib/delivery",
  async () => import("../../../integrations/api/src/lib/delivery"),
)
const delivery = await import("../../../integrations/api/src/lib/delivery")
const { executeTracedFlowStep } = await import(
  "../src/integration/handlers/execution-trace"
)
const traceId = "11111111-1111-4111-8111-111111111111"
const contact = {
  sourceId: "supacrm:be16bc32-75e5-464b-85f6-ba9a562edb6a:34231733",
}
const envelope = { event: "execution.trace", traceId, contact }
const args = {
  callbackUrl: "https://example.test/cb",
  signingSecret: "synthetic",
  envelope,
  timeoutMs: 500,
  retry: 0,
}
function enable() {
  vi.stubEnv("DELIVERY_LATENCY_PROBE", "true")
  vi.stubEnv("RAILWAY_PROJECT_ID", "9ce1c13f-74dc-433b-8c7e-d56aedd58e6a")
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "3e8b511b-4fc0-4e49-9190-c98b0da86a12")
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "info").mockImplementation(() => {
    /* Capture metadata only. */
  })
  post.mockResolvedValue({ text: async () => "" })
  resolve.mockResolvedValue({
    ctx: {
      auth: {
        authType: "custom",
        callbackUrl: args.callbackUrl,
        signingSecret: args.signingSecret,
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
test("off produces no probe output and keeps one POST / timeout / retries", async () => {
  vi.stubEnv("DELIVERY_LATENCY_PROBE", "false")
  await delivery.postSignedEnvelope(args)
  expect(console.info).not.toHaveBeenCalled()
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1]).toMatchObject({ timeout: 500, retry: 0 })
})
test("only selected test trace is allowed; production and other peer are denied", () => {
  enable()
  expect(delivery.latencyProbeAllowed(envelope)).toBe(true)
  expect(
    delivery.latencyProbeAllowed({
      ...envelope,
      contact: { sourceId: "supacrm:other:100" },
    }),
  ).toBe(false)
  vi.stubEnv("RAILWAY_PROJECT_ID", "production")
  expect(delivery.latencyProbeAllowed(envelope)).toBe(false)
})
test("on logs bounded metadata and never changes or retries an aborted POST", async () => {
  enable()
  const error = Object.assign(new Error("sensitive-provider-text"), {
    name: "TimeoutError",
  })
  post.mockRejectedValueOnce(error)
  await expect(delivery.postSignedEnvelope(args)).rejects.toBe(error)
  expect(post).toHaveBeenCalledTimes(1)
  const summary = JSON.stringify(vi.mocked(console.info).mock.calls)
  expect(summary).toContain(traceId)
  expect(summary).toContain("callback.post")
  expect(summary).not.toContain("sensitive-provider-text")
  expect(summary).not.toContain(args.signingSecret)
  expect(summary).not.toContain(args.callbackUrl)
  expect(JSON.parse(post.mock.calls[0][1].body)).toEqual(envelope)
})
test("export failure preserves successful delivery result", async () => {
  enable()
  vi.mocked(console.info).mockImplementation(() => {
    throw new Error("export")
  })
  post.mockResolvedValueOnce({ text: async () => '{"messageId":"1"}' })
  await expect(delivery.postSignedEnvelope(args)).resolves.toEqual({
    messageId: "1",
  })
})
test("finally callback wait is timed separately; original step result survives timeout", async () => {
  enable()
  post.mockRejectedValueOnce(
    Object.assign(new Error("private"), { name: "TimeoutError" }),
  )
  const props = {
    conversation: { workspaceId: "1" },
    contactInbox: { ...contact, channel: "api" },
    flowVersion: { flowId: "flow", nodes: [] },
    targetNodeId: "node",
    flowExecutionKey: "run",
    nodeVisits: {},
    crmNavigation: { traceId },
  } as never
  const result = { status: "success", result: { private: "not exported" } }
  expect(
    await executeTracedFlowStep(
      props,
      { id: "step", stepType: "condition" } as never,
      async () => result,
    ),
  ).toBe(result)
  expect(info).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(info.mock.calls)).toContain("callback.finally")
  expect(JSON.stringify(info.mock.calls)).not.toContain("not exported")
  expect(post).toHaveBeenCalledTimes(1)
})

test("timeout summary pairs the existing delivery header and event type", async () => {
  enable()
  post.mockRejectedValueOnce(
    Object.assign(new Error("private"), { name: "TimeoutError" }),
  )
  await expect(delivery.postSignedEnvelope(args)).rejects.toThrow("private")
  const summary = JSON.parse(vi.mocked(console.info).mock.calls[0][0])
  expect(summary.request_id).toBe(
    post.mock.calls[0][1].headers["X-ChatbotX-Delivery"],
  )
  expect(summary.event_kind).toBe("execution.trace")
  expect(summary.timeout_ms).toBe(500)
  expect(summary.outcome).toBe("timeout")
  expect(
    summary.spans.find((s: { name: string }) => s.name === "callback.post")
      .outcome,
  ).toBe("timeout")
})

test("same trace is capped across POSTs and clock is bounded from process start", () => {
  enable()
  const trace = "33333333-3333-4333-8333-333333333333"
  expect(delivery.takeLatencyBudget(trace, 90)).toBe(90)
  expect(delivery.takeLatencyBudget(trace, 90)).toBe(38)
  expect(delivery.takeLatencyBudget(trace, 1)).toBe(0)
  vi.spyOn(performance, "now").mockReturnValue(900_001)
  expect(delivery.latencyProbeAllowed(envelope)).toBe(false)
})
