import { beforeEach, expect, test, vi } from "vitest"

const { post, resolve, warn } = vi.hoisted(() => ({
  post: vi.fn(),
  resolve: vi.fn(),
  warn: vi.fn(),
}))
vi.mock("@chatbotx.io/integration-api/lib/delivery", () => ({
  postSignedEnvelope: post,
}))
vi.mock("../src/services/integrations", () => ({
  resolveIntegrationContextFromContactInbox: resolve,
}))
vi.mock("../src/lib/logger", () => ({ logger: { warn } }))
const { executeTracedFlowStep } = await import(
  "../src/integration/handlers/execution-trace"
)
const props = {
  conversation: { workspaceId: "1" },
  contactInbox: { channel: "api", sourceId: "supacrm:registry:123" },
  flowVersion: {
    flowId: "flow",
    nodes: [{ id: "node", data: { name: "Decision" } }],
  },
  targetNodeId: "node",
  flowExecutionKey: "execution",
  nodeVisits: { node: 1 },
} as never
const step = {
  id: "step",
  stepType: "condition",
  secret: "never-send",
} as never
beforeEach(() => {
  vi.clearAllMocks()
  resolve.mockResolvedValue({
    ctx: {
      auth: {
        authType: "custom",
        callbackUrl: "https://example.com/cb",
        signingSecret: "secret",
      },
    },
  })
  post.mockResolvedValue(null)
})
test("reports metadata after completion with monotonic duration and per-attempt identity", async () => {
  const handler = vi.fn(async () => ({
    status: "success",
    result: { sensitive: true },
  }))
  expect(await executeTracedFlowStep(props, step, handler)).toEqual({
    status: "success",
    result: { sensitive: true },
  })
  const first = post.mock.calls[0][0]
  expect(first).toMatchObject({
    timeoutMs: 500,
    retry: 0,
    envelope: {
      event: "execution.trace",
      contact: { sourceId: "supacrm:registry:123" },
      trace: {
        flowId: "flow",
        nodeId: "node",
        nodeName: "Decision",
        stepId: "step",
        stepType: "condition",
        status: "success",
      },
    },
  })
  expect(first.envelope.trace.durationMs).toBeGreaterThanOrEqual(0)
  expect(Number.isNaN(Date.parse(first.envelope.trace.startedAt))).toBe(false)
  expect(JSON.stringify(first.envelope)).not.toContain("sensitive")
  expect(JSON.stringify(first.envelope)).not.toContain("never-send")
  await new Promise((resolve) => setTimeout(resolve, 2))
  await executeTracedFlowStep(props, step, handler)
  expect(post.mock.calls[1][0].envelope.operationId).not.toBe(
    first.envelope.operationId,
  )
})
test("reports thrown errors without leaking them or replacing the original failure", async () => {
  const error = new Error("secret provider response")
  post.mockRejectedValue(new Error("secret callback URL"))
  await expect(
    executeTracedFlowStep(props, step, () => Promise.reject(error)),
  ).rejects.toBe(error)
  expect(post.mock.calls[0][0].envelope.trace.status).toBe("error")
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
})
test.each([
  [undefined, "success"],
  [{ status: "wait" }, "waiting"],
  [{ status: "retry" }, "waiting"],
  [{ status: "skip" }, "skip"],
  [{ status: "error" }, "error"],
])("normalizes result %j to %s", async (result, status) => {
  await executeTracedFlowStep(props, step, async () => result)
  expect(post.mock.calls[0][0].envelope.trace.status).toBe(status)
})
test("skips unrelated channels and contacts", async () => {
  for (const contactInbox of [
    { channel: "telegram", sourceId: "supacrm:registry:123" },
    { channel: "api", sourceId: "other" },
  ]) {
    await executeTracedFlowStep(
      { ...(props as object), contactInbox } as never,
      step,
      async () => undefined,
    )
  }
  expect(resolve).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
})
test("callback failure preserves a successful result", async () => {
  post.mockRejectedValue(new Error("private callback response"))
  const result = { status: "success" }
  await expect(
    executeTracedFlowStep(props, step, async () => result),
  ).resolves.toBe(result)
})
test("a deliberate node revisit gets a distinct operation identity", async () => {
  await executeTracedFlowStep(props, step, async () => undefined)
  await executeTracedFlowStep(
    { ...(props as object), nodeVisits: { node: 2 } } as never,
    step,
    async () => undefined,
  )
  expect(post.mock.calls[1][0].envelope.operationId).not.toBe(
    post.mock.calls[0][0].envelope.operationId,
  )
})
test("normal node execution resolves targetId when targetNodeId is absent", async () => {
  await executeTracedFlowStep(
    {
      ...(props as object),
      targetNodeId: undefined,
      targetType: "node",
      targetId: "node",
    } as never,
    step,
    async () => undefined,
  )
  expect(post.mock.calls[0][0].envelope.trace).toMatchObject({
    nodeId: "node",
    nodeName: "Decision",
  })
})
test("button execution resolves its containing node from authored details", async () => {
  await executeTracedFlowStep(
    {
      ...(props as object),
      targetNodeId: "",
      targetType: "button",
      targetId: "button",
      flowVersion: {
        flowId: "flow",
        nodes: [
          {
            id: "owner",
            data: {
              name: "Owner",
              details: {
                steps: [{ id: "message", buttons: [{ id: "button" }] }],
              },
            },
          },
        ],
      },
    } as never,
    step,
    async () => undefined,
  )
  expect(post.mock.calls[0][0].envelope.trace).toMatchObject({
    nodeId: "owner",
    nodeName: "Owner",
  })
})
test("incomplete authored graph still reports a nonempty target identity", async () => {
  await executeTracedFlowStep(
    { ...(props as object), targetNodeId: "", targetId: "button" } as never,
    step,
    async () => undefined,
  )
  expect(post.mock.calls[0][0].envelope.trace.nodeId).toBe("button")
})
