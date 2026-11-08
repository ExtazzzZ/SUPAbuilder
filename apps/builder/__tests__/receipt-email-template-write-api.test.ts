import {
  applyReceiptEmailTemplate,
  configureSupacrmCheckout,
  createSupacrmCheckoutNode,
  createSupacrmEmailNode,
  getReceiptEmailTemplateBase,
  getSupacrmForm,
} from "@chatbotx.io/flow-config"
import { beforeEach, expect, test, vi } from "vitest"

type RouteConfig = {
  method: string
  path: string
  summary: string
  tags: string[]
  successStatus?: number
}

type CapturedProcedure = {
  route: RouteConfig
  handler?: (...args: any[]) => any
}

const { workspaceTokenAuthAPIForScope, capturedProcedures } = vi.hoisted(() => {
  const capturedProcedures: CapturedProcedure[] = []

  const makeProcedure = (route: RouteConfig) => {
    const record: CapturedProcedure = { route }
    capturedProcedures.push(record)

    const chain = {
      input: vi.fn(() => chain),
      output: vi.fn(() => chain),
      errors: vi.fn(() => chain),
      handler: vi.fn((fn: (...args: any[]) => any) => {
        record.handler = fn
        return { handler: fn }
      }),
    }
    return chain
  }

  const workspaceTokenAuthAPI = {
    route: vi.fn((config: RouteConfig) => makeProcedure(config)),
  }

  return {
    workspaceTokenAuthAPIForScope: vi.fn(
      (_scope: string) => workspaceTokenAuthAPI,
    ),
    capturedProcedures,
  }
})

vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))
vi.mock("@/features/flows/api/receipt-email-template", () => ({
  receiptEmailTemplatePublicRouter: {},
}))

const flowService = {
  list: vi.fn(),
  listNodes: vi.fn(),
  findById: vi.fn(),
  createDraft: vi.fn(),
  createPublished: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  duplicate: vi.fn(),
}
const flowVersionService = {
  publish: vi.fn(),
  updateDraftByFlowId: vi.fn(),
  list: vi.fn(),
}
const importService = {
  startFlowImport: vi.fn(),
}
const messengerWelcomeMessageFlowService = {
  listCurrentByFlow: vi.fn(() => Promise.resolve([])),
}
vi.mock("@chatbotx.io/business", () => ({
  flowService,
  flowVersionService,
  messengerWelcomeMessageFlowService,
}))
vi.mock("@chatbotx.io/business/import", () => ({ importService }))

vi.mock("@chatbotx.io/business/errors", () => ({
  BROADCAST_PLAN_LIMIT_CODE: "broadcastPlanLimit",
  validationException: (field: string, message: string) =>
    new Error(`${field}: ${message}`),
}))

const getFlowAuthoringContext = vi.fn(async () => ({
  templatesByName: new Map(),
  customFieldsByName: new Map(),
  flowsByName: new Map(),
}))
vi.mock("@chatbotx.io/business/capabilities", () => ({
  getFlowAuthoringContext,
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  DefaultJobAction: { runImport: "runImport" },
  defaultQueue: { add: vi.fn() },
}))

vi.mock("@chatbotx.io/database/schema", () => {
  const schema = {
    pick: vi.fn(() => schema),
    extend: vi.fn(() => schema),
    omit: vi.fn(() => schema),
    and: vi.fn(() => schema),
  }
  return {
    createSelectSchema: vi.fn(() => schema),
    flowModel: {},
    flowVersionModel: {},
  }
})

await import("@/features/flows/api/public")

const findProcedure = (method: string, path: string) => {
  const found = capturedProcedures.find(
    (p) => p.route.method === method && p.route.path === path,
  )
  if (!found) {
    throw new Error(`No procedure registered for ${method} ${path}`)
  }
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
})

const node = createSupacrmEmailNode({
  nodeProps: { id: "101" },
  dataProps: { isStartNode: true },
})
const sourceRef = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "21",
  nodeId: "30",
} as const
const current = applyReceiptEmailTemplate(node, {
  source: sourceRef,
  snapshot: getSupacrmForm(node.data.details),
  overrides: {},
})
const acknowledged = getReceiptEmailTemplateBase([current])

test("flows.get exposes the current DRAFT template base instead of the published base", async () => {
  flowService.findById.mockResolvedValue({
    id: "100",
    flowVersions: [
      { isDraft: false, nodes: [node] },
      { isDraft: true, nodes: [current] },
    ],
  })
  const result = await findProcedure("GET", "/v1/flows/{id}").handler?.({
    context: { workspace: { id: "1" } },
    input: { id: "100" },
  })
  expect(result.draftTemplateBase).toEqual(acknowledged)
})
test.each([
  "raw",
  "spec",
])("generic updateDraft and publish forward acknowledged base for %s input", async (kind) => {
  const body =
    kind === "raw"
      ? { nodes: [current], edges: [] }
      : {
          spec: {
            formatVersion: 1,
            name: "Test",
            steps: [{ type: "send", text: "Hello" }],
          },
        }
  for (const [method, path, service] of [
    ["PUT", "/v1/flows/{id}/draft", flowVersionService.updateDraftByFlowId],
    ["POST", "/v1/flows/{id}/publish", flowVersionService.publish],
  ] as const) {
    await findProcedure(method, path).handler?.({
      context: { workspace: { id: "1" } },
      input: { ...body, id: "100", expectedTemplateBase: acknowledged },
    })
    expect(service).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "1",
        flowId: "100",
        expectedTemplateBase: acknowledged,
      }),
    )
  }
})
test("raw and spec request schemas preserve the same acknowledged precondition", async () => {
  const { publishFlowRequest, updateDraftFlowRequest } = await import(
    "@/features/flows/schema/action"
  )
  for (const schema of [publishFlowRequest, updateDraftFlowRequest]) {
    for (const body of [
      { nodes: [current], edges: [] },
      {
        spec: {
          formatVersion: 1,
          name: "Test",
          steps: [{ type: "send", text: "Hello" }],
        },
      },
    ]) {
      expect(
        schema.parse({ ...body, expectedTemplateBase: acknowledged })
          .expectedTemplateBase,
      ).toEqual(acknowledged)
    }
  }
})

test("benefit edits reach public draft/publish with same opaque ports, edges and Email template base", async () => {
  const original = createSupacrmCheckoutNode({ nodeProps: { id: "102" } }, "bonus")
  const changed = configureSupacrmCheckout(original, { ...original.data.details.supacrmCheckout, prompt: "Новый вопрос", skipLabel: "Оплатить без бонусов" })
  const edge = { id: "201", source: changed.id, sourceHandle: changed.data.details.quickReplies[0].id, target: current.id, targetHandle: current.id }
  const { publishFlowRequest } = await import("@/features/flows/schema/action")
  const body = publishFlowRequest.parse({ nodes: [changed, current], edges: [edge], expectedTemplateBase: acknowledged })
  for (const [method, path, service] of [["PUT", "/v1/flows/{id}/draft", flowVersionService.updateDraftByFlowId], ["POST", "/v1/flows/{id}/publish", flowVersionService.publish]] as const) {
    await findProcedure(method, path).handler?.({ context: { workspace: { id: "1" } }, input: { ...body, id: "100" } })
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ nodes: [changed, current], edges: [edge], expectedTemplateBase: acknowledged }))
  }
  expect(changed.data.details.quickReplies).toEqual(original.data.details.quickReplies)
  expect(getReceiptEmailTemplateBase([changed, current])).toEqual(acknowledged)
  for (const corrupt of [
    { ...changed, data: { ...changed.data, details: { ...changed.data.details, supacrmCheckout: { ...changed.data.details.supacrmCheckout, reward: 1 } } } },
    { ...changed, data: { ...changed.data, details: { ...changed.data.details, quickReplies: changed.data.details.quickReplies.slice(1) } } },
  ]) { expect(publishFlowRequest.safeParse({ nodes: [corrupt, current], edges: [edge], expectedTemplateBase: acknowledged }).success).toBe(false) }
})
