import {
  applyReceiptEmailTemplate,
  createSupacrmEmailNode,
  getSupacrmForm,
  type SendMessageNodeSchema,
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
vi.mock("../src/supacrm-source-binding/service", () => ({
  supacrmSourceBindingService: { withLegacyFlow: h.guard },
}))
vi.mock("../src/decision/profile-service", () => ({
  decisionProfileService: { assertFlowReferencesPublishable: vi.fn() },
}))
vi.mock("../src/messenger-welcome-message-flow/service", () => ({
  messengerWelcomeMessageFlowService: { enqueueSync: vi.fn() },
}))
vi.mock("../src/smart-delay/service", () => ({
  smartDelayService: { cancelQuickReplyFollowUpsForStaleVersion: vi.fn() },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: { clearQuickReplyChallengesForStaleVersion: vi.fn() },
}))
vi.mock("../src/base.service", () => ({
  BaseService: class {
    invalidateCacheTags() {
      return Promise.resolve()
    }
    audit() {
      return Promise.resolve()
    }
  },
}))
const { flowVersionService } = await import("../src/flow-version/service")
const { receiptEmailTemplateService } = await import(
  "../src/flow-version/receipt-email-template"
)
const source = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "21",
  nodeId: "30",
} as const
const make = () =>
  createSupacrmEmailNode({
    nodeProps: { id: "101" },
    dataProps: { isStartNode: true },
  })
const bound = (node: SendMessageNodeSchema, revision: string) =>
  applyReceiptEmailTemplate(node, {
    source: { ...source, flowVersionId: revision },
    snapshot: getSupacrmForm(node.data.details),
    overrides: {},
  })
const base = (nodes: SendMessageNodeSchema[]) =>
  nodes.flatMap((node) =>
    node.data.details.supacrmFormTemplate
      ? [{ nodeId: node.id, template: node.data.details.supacrmFormTemplate }]
      : [],
  )
let draft: {
  id: string
  flowId: string
  workspaceId: string
  isDraft: boolean
  nodes: SendMessageNodeSchema[]
  edges: []
}
const tx = {
  query: {
    flowVersionModel: { findFirst: h.find },
    flowModel: { findFirst: h.flow },
  },
  update: () => ({
    set: (value: { nodes?: SendMessageNodeSchema[] }) => ({
      where: () => {
        h.writes(value)
        if (value.nodes) {
          draft.nodes = value.nodes
        }
        return Promise.resolve()
      },
    }),
  }),
  insert: () => ({ values: h.insert }),
}
beforeEach(() => {
  draft = {
    id: "201",
    flowId: "100",
    workspaceId: "1",
    isDraft: true,
    nodes: [bound(make(), "20")],
    edges: [],
  }
  h.guard.mockReset().mockImplementation((_scope, work) => work(tx))
  h.find.mockReset().mockImplementation(({ where }) =>
    Promise.resolve(
      where.isDraft === false
        ? {
            id: "21",
            flowId: "10",
            workspaceId: "1",
            isDraft: false,
            nodes: [createSupacrmEmailNode({ nodeProps: { id: "30" } })],
          }
        : draft,
    ),
  )
  h.flow
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve({ id: "100", workspaceId: "1", flowVersions: [draft] }),
    )
  h.writes.mockReset()
  h.insert.mockReset().mockResolvedValue(undefined)
})
const write = (
  method: "updateDraft" | "updateDraftByFlowId" | "publish",
  nodes: SendMessageNodeSchema[],
  expectedTemplateBase?: ReturnType<typeof base>,
) => {
  const request = {
    workspaceId: "1",
    flowId: "100",
    id: "201",
    nodes,
    edges: [],
    expectedTemplateBase,
  }
  return flowVersionService[method](request)
}

test.each([
  "updateDraft",
  "updateDraftByFlowId",
  "publish",
] as const)("%s rejects stale linked/unlinked bases and omission after actual agent adoption", async (method) => {
  for (const linked of [true, false]) {
    const stale = linked ? bound(make(), "20") : make()
    const expectedTemplateBase = base([stale])
    const current = draft.nodes[0]
    await receiptEmailTemplateService.change({
      workspaceId: "1",
      flowId: "100",
      nodeId: "101",
      expectedNode: current,
      source,
      action: "adopt",
    })
    h.writes.mockClear()
    await expect(write(method, [stale], expectedTemplateBase)).rejects.toThrow(
      "Общие настройки изменились",
    )
    await expect(write(method, [stale])).rejects.toThrow(
      "Общие настройки изменились",
    )
    expect(h.writes).not.toHaveBeenCalled()
    expect(
      draft.nodes[0].data.details.supacrmFormTemplate?.source.flowVersionId,
    ).toBe("21")
  }
})
test.each([
  "updateDraft",
  "updateDraftByFlowId",
  "publish",
] as const)("%s permits deliberate undo/detach/redo with the current acknowledged base", async (method) => {
  for (const next of [make(), bound(make(), "21"), bound(make(), "20")]) {
    await write(method, [next], base(draft.nodes))
    expect(draft.nodes[0]).toEqual(next)
  }
})
test("ordinary untemplated flows preserve existing blind-save behavior", async () => {
  draft.nodes = [make()]
  await write("updateDraftByFlowId", [make()])
  expect(h.writes).toHaveBeenCalledOnce()
})
