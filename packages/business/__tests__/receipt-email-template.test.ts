import {
  createSupacrmEmailNode,
  getSupacrmForm,
  receiptEmailContentKey,
} from "@chatbotx.io/flow-config"
import { beforeEach, expect, test, vi } from "vitest"

const privateValuesPattern = /nodes|snapshot|receiptEmail|Локальный вопрос/

const h = vi.hoisted(() => ({
  find: vi.fn(),
  many: vi.fn(),
  flows: vi.fn(),
  update: vi.fn(),
  guard: vi.fn(),
}))
vi.mock("../src/supacrm-source-binding/service", () => ({
  supacrmSourceBindingService: { withLegacyFlow: h.guard },
}))
vi.mock("@chatbotx.io/database/client", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/database/client")>()),
  db: {
    query: {
      flowVersionModel: { findMany: h.many },
      flowModel: { findMany: h.flows },
    },
  },
}))
const source = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "20",
  nodeId: "30",
} as const
const make = (id: string) =>
  createSupacrmEmailNode({
    nodeProps: { id },
    dataProps: { isStartNode: true },
  })
let consumer = make("101")
let draft: { id: string; nodes: unknown[]; edges: unknown[] }
let sourceRow: Record<string, unknown>
const tx = {
  query: { flowVersionModel: { findFirst: h.find } },
  update: () => ({ set: h.update }),
}
beforeEach(() => {
  consumer = make("101")
  draft = {
    id: "201",
    nodes: [consumer, { id: "999", untouched: "fresh-other-node" }],
    edges: [{ id: "edge", source: "101", target: "999" }],
  }
  sourceRow = {
    id: "20",
    flowId: "10",
    workspaceId: "1",
    isDraft: false,
    nodes: [make("30")],
  }
  h.guard.mockReset().mockImplementation(async (_scope, work) => work(tx))
  h.find
    .mockReset()
    .mockImplementation(async ({ where }) =>
      where.isDraft === true ? draft : sourceRow,
    )
  h.update.mockReset().mockImplementation((input) => ({
    where: () => {
      draft = { ...draft, ...input }
      return Promise.resolve()
    },
  }))
  h.many.mockReset()
  h.flows.mockReset().mockResolvedValue([
    { id: "100", name: "Товар A" },
    { id: "10", name: "Общие формы" },
  ])
})
const api = async () =>
  (await import("../src/flow-version/receipt-email-template"))
    .receiptEmailTemplateService
const request = () => ({
  workspaceId: "1",
  flowId: "100",
  nodeId: "101",
  expectedNode: consumer as unknown as Record<string, unknown>,
  source,
  overrides: { prompt: "Локальный вопрос" },
})

test("preview/adopt resolve non-draft same-workspace source and patch only expected consumer under existing guard", async () => {
  const module = await import("../src/flow-version/index")
  expect(module).toHaveProperty("receiptEmailTemplateService")
  const service = await api()
  const preview = await service.change({ ...request(), action: "preview" })
  expect(h.update).not.toHaveBeenCalled()
  expect(preview.status).toBe("ready")
  const result = await service.change({ ...request(), action: "adopt" })
  expect(result.status).toBe("ready")
  expect(h.guard).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "1",
      flowId: "100",
      operation: "updateDraft",
    }),
    expect.any(Function),
  )
  expect(draft.nodes[1]).toEqual({ id: "999", untouched: "fresh-other-node" })
  expect(draft.edges).toEqual([{ id: "edge", source: "101", target: "999" }])
  expect(
    getSupacrmForm((draft.nodes[0] as typeof consumer).data.details)?.prompt,
  ).toBe("Локальный вопрос")
})
test("stale expected node rejects without writes instead of overwriting fresh content", async () => {
  expect(await import("../src/flow-version/index")).toHaveProperty(
    "receiptEmailTemplateService",
  )
  draft.nodes[0] = {
    ...consumer,
    data: { ...consumer.data, name: "Другой автор" },
  }
  await expect(
    (await api()).change({ ...request(), action: "adopt" }),
  ).rejects.toThrow()
  expect(h.update).not.toHaveBeenCalled()
})
test.each([
  "foreign",
  "draft",
  "missing",
])("%s source cannot be adopted and does not erase consumer", async (kind) => {
  expect(await import("../src/flow-version/index")).toHaveProperty(
    "receiptEmailTemplateService",
  )
  if (kind === "foreign") {
    sourceRow.workspaceId = "2"
  }
  if (kind === "draft") {
    sourceRow.isDraft = true
  }
  if (kind === "missing") {
    h.find.mockImplementation(async ({ where }) =>
      where.isDraft === true ? draft : undefined,
    )
  }
  const before = receiptEmailContentKey(draft)
  expect(
    (await (await api()).change({ ...request(), action: "preview" })).status,
  ).toBe("unavailable")
  await expect(
    (await api()).change({ ...request(), action: "adopt" }),
  ).rejects.toThrow()
  expect(receiptEmailContentKey(draft)).toBe(before)
  expect(h.update).not.toHaveBeenCalled()
})

test("a previously accepted snapshot detaches even after source deletion", async () => {
  const service = await api()
  await service.change({ ...request(), action: "adopt" })
  const accepted = draft.nodes[0] as typeof consumer
  h.find.mockImplementation(async ({ where }) =>
    where.isDraft === true ? draft : undefined,
  )
  const result = await service.change({
    ...request(),
    expectedNode: accepted as unknown as Record<string, unknown>,
    action: "detach",
  })
  expect(result.status).toBe("ready")
  expect(
    (draft.nodes[0] as typeof consumer).data.details.supacrmFormTemplate,
  ).toBeUndefined()
  expect(
    getSupacrmForm((draft.nodes[0] as typeof consumer).data.details),
  ).toEqual(getSupacrmForm(accepted.data.details))
})
test("usage returns workspace-scoped draft/published identities with labels and no graph/client values", async () => {
  await (await api()).change({ ...request(), action: "adopt" })
  h.many.mockResolvedValue([
    { ...draft, workspaceId: "1", flowId: "100", isDraft: true },
    { ...draft, id: "202", workspaceId: "1", flowId: "100", isDraft: false },
  ])
  const usages = await (await api()).usages({ workspaceId: "1", flowId: "10" })
  expect(h.many).toHaveBeenCalledWith({ where: { workspaceId: "1" } })
  expect(usages.map((item) => item.isDraft)).toEqual([true, false])
  expect(usages[0]).toMatchObject({
    flowName: "Товар A",
    acceptedVersionId: "20",
  })
  expect(JSON.stringify(usages)).not.toMatch(privateValuesPattern)
})
test("preview cannot overwrite unrelated fresh nodes when optional canvas graph is stale", async () => {
  const expectedGraph = structuredClone(draft)
  draft.nodes[1] = { id: "999", name: "Изменение другого автора" }
  await expect(
    (await api()).change({ ...request(), action: "adopt", expectedGraph }),
  ).rejects.toThrow()
  expect(h.update).not.toHaveBeenCalled()
})
