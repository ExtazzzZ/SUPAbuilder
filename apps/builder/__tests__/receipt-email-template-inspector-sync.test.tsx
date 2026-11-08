import type { receiptEmailTemplateCandidateSchema } from "@chatbotx.io/business"
import {
  applyReceiptEmailTemplate,
  createSupacrmEmailNode,
  detachReceiptEmailTemplate,
  getSupacrmForm,
  receiptEmailTemplateSourceSchema,
  type SendMessageNodeSchema,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, expect, test, vi } from "vitest"
import type { z } from "zod"
import { selectedNodeEqualityFn } from "../src/features/flows/react-flow/nodes/selected-node-equality"
import { createFlowHistoryStore } from "../src/features/flows/react-flow/stores/flow-history-store"
import { SupacrmFormEditor } from "../src/features/flows/supacrm-form/form-editor"

const h = vi.hoisted(() => ({
  run: vi.fn(),
  getNode: vi.fn(),
  updateNodeData: vi.fn(),
  snapshot: vi.fn(),
  candidates: vi.fn(),
  usages: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    getNode: h.getNode,
    updateNodeData: h.updateNodeData,
  }),
}))
vi.mock("@/features/flows/react-flow/stores/use-flow-history", () => ({
  useFlowHistory: () => ({ takeSnapshot: h.snapshot }),
}))
vi.mock("@/features/flows/supacrm-form/template-draft-context", () => ({
  useReceiptEmailTemplateDraft: () => ({ run: h.run }),
}))
vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    flowsAPI: {
      privateReceiptEmailTemplateCandidates: h.candidates,
      privateReceiptEmailTemplateUsages: h.usages,
    },
  },
}))
const candidate: z.infer<typeof receiptEmailTemplateCandidateSchema> = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "20",
  nodeId: "30",
  label: "Общая почта",
  flowName: "Общие формы",
  publishedAt: "2026-11-06T00:00:00.000Z",
  isLatest: true,
  versionNumber: 1,
}
const source = receiptEmailTemplateSourceSchema.parse({
  kind: candidate.kind,
  flowId: candidate.flowId,
  flowVersionId: candidate.flowVersionId,
  nodeId: candidate.nodeId,
})
let current: SendMessageNodeSchema
beforeEach(() => {
  current = createSupacrmEmailNode({ nodeProps: { id: "101" } })
  h.candidates.mockResolvedValue({ data: [candidate] })
  h.usages.mockResolvedValue({ data: [] })
  h.getNode.mockImplementation(() => current)
})
async function mount() {
  const history = createFlowHistoryStore()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = () =>
    root.render(
      <SupacrmFormEditor
        nodeDetails={current.data.details}
        nodeId={current.id}
      />,
    )
  history.getState().setRestoreHandlers({
    setNodes: (nodes) => {
      current = nodes[0] as SendMessageNodeSchema
      render()
    },
    setEdges: () => undefined,
  })
  h.snapshot.mockImplementation(() =>
    history.getState().takeSnapshot([current], []),
  )
  h.updateNodeData.mockImplementation((_id, data) => {
    current = { ...current, data }
    render()
  })
  h.run.mockImplementation((request) => {
    const next =
      request.action === "detach"
        ? detachReceiptEmailTemplate(current)
        : applyReceiptEmailTemplate(current, {
            source,
            snapshot: getSupacrmForm(createSupacrmEmailNode({}).data.details),
            overrides: request.overrides,
          })
    if (request.action !== "preview") {
      history.getState().takeSnapshot([current], [])
      current = next
      render()
    }
    return Promise.resolve({ status: "ready", node: next, changes: [] })
  })
  await act(render)
  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === name,
    )
    if (!found) {
      throw new Error(`Missing ${name}`)
    }
    return found
  }
  const select = container.querySelector("select")
  if (!select) {
    throw new Error("Missing selector")
  }
  await act(() => {
    select.value = "10:20:30"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  return {
    container,
    history,
    button,
    render,
    close: async () => {
      await act(() => root.unmount())
      container.remove()
    },
  }
}
const input = async (field: HTMLTextAreaElement | null, value: string) => {
  if (!field) {
    throw new Error("Missing field")
  }
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
test("I2 ordinary question save then bind retains the current question, while deliberate pending override survives unrelated local edits", async () => {
  const ui = await mount()
  try {
    await input(
      ui.container.querySelector('textarea[name="prompt"]'),
      "Только что сохранённый вопрос",
    )
    await act(() => ui.button("supacrmForm.save").click())
    expect(getSupacrmForm(current.data.details)?.prompt).toBe(
      "Только что сохранённый вопрос",
    )
    await act(() => ui.button("supacrmTemplate.preview").click())
    expect(h.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        overrides: { prompt: "Только что сохранённый вопрос" },
      }),
    )
    await act(() => ui.button("supacrmTemplate.adopt").click())
    expect(getSupacrmForm(current.data.details)?.prompt).toBe(
      "Только что сохранённый вопрос",
    )
  } finally {
    await ui.close()
  }
})
test("I3 actual history undo/redo and detach undo refresh the same mounted inspector", async () => {
  const ui = await mount()
  try {
    await act(() => ui.button("supacrmTemplate.preview").click())
    await act(() => ui.button("supacrmTemplate.adopt").click())
    expect(
      ui.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
        ?.disabled,
    ).toBe(true)
    expect(ui.container.textContent).toContain("supacrmTemplate.accepted")
    await act(() => {
      ui.history.getState().undo({ nodes: [current], edges: [] })
    })
    expect(current.data.details.supacrmFormTemplate).toBeUndefined()
    expect(
      ui.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
        ?.disabled,
    ).toBe(false)
    expect(ui.container.textContent).not.toContain("supacrmTemplate.accepted")
    await act(() => {
      ui.history.getState().redo({ nodes: [current], edges: [] })
    })
    expect(
      ui.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
        ?.disabled,
    ).toBe(true)
    expect(ui.container.textContent).toContain("Общие формы · Общая почта · v1")
    await act(() => ui.button("supacrmTemplate.detach").click())
    expect(
      ui.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
        ?.disabled,
    ).toBe(false)
    await act(() => {
      ui.history.getState().undo({ nodes: [current], edges: [] })
    })
    expect(
      ui.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
        ?.disabled,
    ).toBe(true)
    expect(ui.container.textContent).toContain("supacrmTemplate.accepted")
  } finally {
    await ui.close()
  }
})
test("the ordinary selected-node subscription observes Email detail changes for history without remount", () => {
  const changed = applyReceiptEmailTemplate(current, {
    source,
    snapshot: getSupacrmForm(current.data.details),
    overrides: {},
  })
  expect(selectedNodeEqualityFn(current, changed)).toBe(false)
})

test("a deliberately typed pending prompt override survives an ordinary local question edit", async () => {
  const ui = await mount()
  try {
    await input(
      ui.container.querySelector("section textarea"),
      "Мой отдельный вопрос",
    )
    await input(
      ui.container.querySelector('textarea[name="prompt"]'),
      "Новый общий локальный вопрос",
    )
    await act(() => ui.button("supacrmForm.save").click())
    await act(() => ui.button("supacrmTemplate.preview").click())
    expect(h.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        overrides: { prompt: "Мой отдельный вопрос" },
      }),
    )
  } finally {
    await ui.close()
  }
})
