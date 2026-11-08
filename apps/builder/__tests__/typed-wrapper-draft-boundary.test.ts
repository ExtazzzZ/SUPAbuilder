// @vitest-environment node
import {
  applyReceiptEmailTemplate,
  createSupacrmCheckoutNode,
  createSupacrmEmailNode,
  getReceiptEmailTemplateBase,
  getSupacrmForm,
} from "@chatbotx.io/flow-config"
import { beforeEach, expect, test, vi } from "vitest"

const h = vi.hoisted(() => ({
  find: vi.fn(),
  flow: vi.fn(),
  writes: vi.fn(),
  insert: vi.fn(),
  guard: vi.fn(),
}))
vi.mock("@chatbotx.io/database/client", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/database/client")>()),
  db: { query: { flowVersionModel: { findFirst: h.find } } },
}))
vi.mock(
  "../../../packages/business/src/supacrm-source-binding/service",
  () => ({
    supacrmSourceBindingService: { withLegacyFlow: h.guard },
  }),
)
vi.mock("../../../packages/business/src/decision/profile-service", () => ({
  decisionProfileService: { assertFlowReferencesPublishable: vi.fn() },
}))
vi.mock(
  "../../../packages/business/src/messenger-welcome-message-flow/service",
  () => ({
    messengerWelcomeMessageFlowService: { enqueueSync: vi.fn() },
  }),
)
vi.mock("../../../packages/business/src/smart-delay/service", () => ({
  smartDelayService: { cancelQuickReplyFollowUpsForStaleVersion: vi.fn() },
}))
vi.mock("../../../packages/business/src/conversation/service", () => ({
  conversationService: { clearQuickReplyChallengesForStaleVersion: vi.fn() },
}))
vi.mock("../../../packages/business/src/base.service", () => ({
  BaseService: class {
    invalidateCacheTags() {
      return Promise.resolve()
    }
    audit() {
      return Promise.resolve()
    }
  },
}))

vi.mock("@/orpc", async () => {
  const { os } = await import("@orpc/server")
  return {
    workspaceTokenAuthAPIForScope: () =>
      os.$context<{ workspace: { id: string } }>(),
  }
})
vi.mock("@/features/flows/api/receipt-email-template", () => ({
  receiptEmailTemplatePublicRouter: {},
}))
vi.mock("@chatbotx.io/business", async () => ({
  flowVersionService: (
    await import("../../../packages/business/src/flow-version/service")
  ).flowVersionService,
  flowService: {
    findById: async () => ({
      id: "100",
      name: "Synthetic",
      createdAt: new Date(),
      updatedAt: new Date(),
      active: false,
      enableInInbox: false,
      currentVersionId: null,
      draftVersionId: "201",
      workspaceId: "1",
      folderId: null,
      flowVersions: [
        {
          ...draft,
          createdAt: new Date(),
          isLatest: false,
          startNodeId: "102",
        },
      ],
    }),
  },
  messengerWelcomeMessageFlowService: { listCurrentByFlow: async () => [] },
}))
vi.mock("@chatbotx.io/business/import", () => ({ importService: {} }))
vi.mock("@chatbotx.io/worker-config", () => ({
  DefaultJobAction: { runImport: "runImport" },
  defaultQueue: { add: vi.fn() },
}))
vi.mock("@chatbotx.io/business/capabilities", () => ({
  getFlowAuthoringContext: vi.fn(),
}))
const { flowVersionService } = await import(
  "../../../packages/business/src/flow-version/service"
)
const { flowsPublicRouter } = await import("@/features/flows/api/public")
const { OpenAPIHandler } = await import("@orpc/openapi/fetch")
const http = new OpenAPIHandler({ updateDraft: flowsPublicRouter.updateDraft })
let draft: {
  id: string
  flowId: string
  workspaceId: string
  isDraft: boolean
  nodes: any[]
  edges: []
}
const tx = {
  query: {
    flowVersionModel: { findFirst: h.find },
    flowModel: { findFirst: h.flow },
  },
  update: () => ({
    set: (value: { nodes: any[] }) => ({
      where: () => {
        h.writes(value)
        draft.nodes = structuredClone(value.nodes)
        return Promise.resolve()
      },
    }),
  }),
}
const bonus = () =>
  createSupacrmCheckoutNode({ nodeProps: { id: "102" } }, "bonus")
const email = () =>
  applyReceiptEmailTemplate(
    createSupacrmEmailNode({ nodeProps: { id: "101" } }),
    {
      source: {
        kind: "receiptEmail",
        flowId: "10",
        flowVersionId: "21",
        nodeId: "30",
      },
      snapshot: getSupacrmForm(createSupacrmEmailNode({}).data.details),
      overrides: {},
    },
  )
beforeEach(() => {
  draft = {
    id: "201",
    flowId: "100",
    workspaceId: "1",
    isDraft: true,
    nodes: [bonus(), email()],
    edges: [],
  }
  h.find.mockReset().mockImplementation(async () => draft)
  h.flow.mockReset().mockResolvedValue({ id: "100", workspaceId: "1" })
  h.guard.mockReset().mockImplementation((_scope, work) => work(tx))
  h.writes.mockReset()
})
const request = async (
  nodes: any[],
  expectedTemplateBase = getReceiptEmailTemplateBase(draft.nodes),
) => {
  const result = await http.handle(
    new Request("http://localhost/v1/flows/100/draft", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes, edges: [], expectedTemplateBase }),
    }),
    { context: { workspace: { id: "1" } } as never },
  )
  if (!result.matched) {
    throw new Error("Public draft route not matched")
  }
  return result.response
}
const corruptions: Record<string, (node: any) => void> = {
  amountRUB: (n) => {
    n.data.details.supacrmCheckout.amountRUB = 100_000
  },
  nullLabel: (n) => {
    n.data.details.supacrmCheckout.skipLabel = null
  },
  wrongKind: (n) => {
    n.data.details.supacrmCheckout.kind = "promo"
  },
  cardinality: (n) => {
    n.data.details.quickReplies.pop()
  },
  marker: (n) => {
    n.data.details.steps[0].text = "forged"
  },
  wrongNodeType: (n) => {
    n.type = "condition"
  },
}
test.each(
  Object.keys(corruptions),
)("public HTTP draft rejects %s before persistence", async (key) => {
  const before = structuredClone(draft)
  const node = bonus()
  corruptions[key](node)
  expect((await request([node, email()])).status).toBe(400)
  expect(h.writes).not.toHaveBeenCalled()
  expect(draft).toEqual(before)
})
test.each([
  "updateDraft",
  "updateDraftByFlowId",
] as const)("real %s also rejects invalid wrappers when UI bypasses public parser", async (method) => {
  const node = bonus()
  corruptions.amountRUB(node)
  const before = structuredClone(draft)
  await expect(
    flowVersionService[method]({
      workspaceId: "1",
      id: "201",
      flowId: "100",
      nodes: [node, email()],
      edges: [],
      expectedTemplateBase: getReceiptEmailTemplateBase(draft.nodes),
    }),
  ).rejects.toThrow()
  expect(h.writes).not.toHaveBeenCalled()
  expect(draft).toEqual(before)
})
test("public draft preserves arbitrary plugin metadata and incomplete disconnected ordinary nodes", async () => {
  const ordinary = {
    id: "300",
    type: "sendMessage",
    data: { details: { otherPlugin: { amountRUB: 100_000 }, steps: [] } },
  }
  const node = bonus() as any
  node.data.details.otherPlugin = { arbitrary: { retain: true } }
  const nodes = [node, email(), ordinary]
  expect((await request(nodes)).status).toBe(204)
  expect(h.writes).toHaveBeenCalledOnce()
  expect(draft.nodes).toEqual(nodes)
})
test("existing invalid persisted draft remains readable and repair requires fresh template base", async () => {
  corruptions.amountRUB(draft.nodes[0])
  const { call } = await import("@orpc/server")
  const read = await call(
    flowsPublicRouter.get,
    { id: "100" },
    { context: { workspace: { id: "1" } } as never },
  )
  expect(read.flowVersions[0].nodes[0]).toMatchObject({
    data: { details: { supacrmCheckout: { amountRUB: 100_000 } } },
  })
  expect(read.draftTemplateBase).toEqual(
    getReceiptEmailTemplateBase(draft.nodes),
  )
  expect((await request([bonus(), email()], [])).status).toBeGreaterThanOrEqual(
    400,
  )
  expect(h.writes).not.toHaveBeenCalled()
  expect(
    (await request([bonus(), email()], read.draftTemplateBase)).status,
  ).toBe(204)
  expect(draft.nodes[0].data.details.supacrmCheckout).not.toHaveProperty(
    "amountRUB",
  )
})
