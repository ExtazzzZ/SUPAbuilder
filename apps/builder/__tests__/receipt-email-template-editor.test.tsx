import {
  applyReceiptEmailTemplate,
  createSupacrmEmailNode,
  getSupacrmForm,
  supacrmFormSchema,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"

const h = vi.hoisted(() => ({
  run: vi.fn(),
  candidates: vi.fn(),
  usages: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))
vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    flowsAPI: {
      privateReceiptEmailTemplateCandidates: h.candidates,
      privateReceiptEmailTemplateUsages: h.usages,
    },
  },
}))
vi.mock("@/features/flows/supacrm-form/template-draft-context", () => ({
  useReceiptEmailTemplateDraft: () => ({ run: h.run }),
}))

test("requires preview then explicit adoption of exact revision and retains prompt override", async () => {
  const module = await import(
    "../src/features/flows/supacrm-form/template-editor"
  )
  expect(module).toHaveProperty("ReceiptEmailTemplateEditor")
  const node = createSupacrmEmailNode({ nodeProps: { id: "101" } })
  const source = {
    kind: "receiptEmail",
    flowId: "10",
    flowVersionId: "20",
    nodeId: "30",
    label: "Общее поле",
  } as const
  h.candidates.mockResolvedValue({ data: [source] })
  h.usages.mockResolvedValue({ data: [] })
  const accepted = applyReceiptEmailTemplate(node, {
    source: {
      kind: source.kind,
      flowId: source.flowId,
      flowVersionId: source.flowVersionId,
      nodeId: source.nodeId,
    },
    snapshot: getSupacrmForm(node.data.details),
    overrides: { prompt: "Мой вопрос" },
  })
  h.run.mockResolvedValue({ status: "ready", node: accepted, changes: [] })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <module.ReceiptEmailTemplateEditor
          binding={undefined}
          nodeId="101"
          onApplied={vi.fn()}
          settings={supacrmFormSchema.parse(getSupacrmForm(node.data.details))}
        />,
      ),
    )
    const select = container.querySelector("select")
    if (!select) {
      throw new Error("Missing source selector")
    }
    await act(() => {
      select.value = "10:20:30"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.textContent).not.toContain("supacrmTemplate.adopt")
    const button = (name: string) => {
      const found = Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent === name,
      )
      if (!found) {
        throw new Error("Missing button")
      }
      return found
    }
    await act(() => button("supacrmTemplate.preview").click())
    expect(h.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "preview",
        source: expect.objectContaining({ flowVersionId: "20" }),
      }),
    )
    await act(() => button("supacrmTemplate.adopt").click())
    expect(h.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "adopt",
        source: expect.objectContaining({ flowVersionId: "20" }),
      }),
    )
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
