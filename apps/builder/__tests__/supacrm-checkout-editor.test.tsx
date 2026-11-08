// @vitest-environment jsdom
import {
  configureSupacrmCheckout,
  createSupacrmCheckoutNode,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { addSupacrmCheckoutNode } from "../src/features/flows/supacrm-checkout/add-checkout-node"
import { SupacrmCheckoutEditor } from "../src/features/flows/supacrm-checkout/checkout-editor"

const h = vi.hoisted(() => ({
  getNode: vi.fn(),
  updateNodeData: vi.fn(),
  takeSnapshot: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@xyflow/react", () => ({ useReactFlow: () => h }))
vi.mock("@/features/flows/react-flow/stores/use-flow-history", () => ({
  useFlowHistory: () => h,
}))
it("edits presentation and timeout, preserving native ports and editor metadata", async () => {
  const node = createSupacrmCheckoutNode({}, "wait")
  node.data.editorMetadata = {
    section: { id: "checkout", title: "Оформление" },
  }
  h.getNode.mockReturnValue(node)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(() =>
      root.render(
        <SupacrmCheckoutEditor
          nodeDetails={node.data.details}
          nodeId={node.id}
        />,
      ),
    )
    expect(host.querySelectorAll("textarea")).toHaveLength(1)
    expect(host.textContent).toContain("supacrmCheckout.waitNotice")
    const form = host.querySelector("form")
    if (!form) {
      throw new Error("Missing checkout form")
    }
    await act(() =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    )
    const saved = h.updateNodeData.mock.calls[0][1]
    expect(saved.editorMetadata).toEqual(node.data.editorMetadata)
    expect(saved.details.quickReplies).toEqual(node.data.details.quickReplies)
    expect(saved.details.quickReplies).toHaveLength(3)
    expect(saved.details.supacrmCheckout).toEqual(
      node.data.details.supacrmCheckout,
    )
  } finally {
    await act(() => root.unmount())
    host.remove()
  }
})
it("palette helper creates all four strict blocks with translated outputs", () => {
  const addNodes = vi.fn()
  for (const kind of ["offer", "receipt", "link", "wait"] as const) {
    addSupacrmCheckoutNode(
      { addNodes, screenToFlowPosition: (value) => value } as Parameters<
        typeof addSupacrmCheckoutNode
      >[0],
      ((key: string) => key) as unknown as Parameters<
        typeof addSupacrmCheckoutNode
      >[1],
      kind,
    )
  }
  expect(
    addNodes.mock.calls.map(
      (call) => call[0][0].data.details.quickReplies.length,
    ),
  ).toEqual([4, 3, 6, 3])
  expect(addNodes.mock.calls[3][0][0].data.details.quickReplies[0].label).toBe(
    "supacrmCheckout.paid",
  )
})

it.each([
  "promo",
  "bonus",
  "referral_summary",
] as const)("edits real prompt and choice for %s", async (kind) => {
  h.updateNodeData.mockClear()
  const node = createSupacrmCheckoutNode({}, kind)
  h.getNode.mockReturnValue(node)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(() =>
      root.render(
        <SupacrmCheckoutEditor
          nodeDetails={node.data.details}
          nodeId={node.id}
        />,
      ),
    )
    const prompt = host.querySelector("textarea")
    if (!prompt) {
      throw new Error("Missing prompt")
    }
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(prompt, "Изменённый вопрос")
      prompt.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const choice = host.querySelector<HTMLInputElement>(
      kind === "referral_summary"
        ? `[id="${node.id}-continueLabel"]`
        : `[id="${node.id}-skipLabel"]`,
    )
    if (!choice) {
      throw new Error("Missing choice")
    }
    expect(choice).not.toBeNull()
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(choice, "Другой выбор")
      choice.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(() =>
      host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    )
    const saved = h.updateNodeData.mock.calls[0][1]
    expect(saved.details.supacrmCheckout.prompt).toBe("Изменённый вопрос")
    expect(
      saved.details.supacrmCheckout[
        kind === "referral_summary" ? "continueLabel" : "skipLabel"
      ],
    ).toBe("Другой выбор")
    expect(saved.details.quickReplies).toEqual(node.data.details.quickReplies)
    expect(saved.details.steps[0].id).toBe(node.data.details.steps[0].id)
  } finally {
    await act(() => root.unmount())
    host.remove()
  }
})

it.each([
  "promo",
  "bonus",
  "receipt",
] as const)("%s skipped canvas semantics survive settings edits with identical handles", (kind) => {
  const addNodes = vi.fn()
  addSupacrmCheckoutNode(
    { addNodes, screenToFlowPosition: (value) => value } as Parameters<
      typeof addSupacrmCheckoutNode
    >[0],
    ((key: string) => key) as Parameters<typeof addSupacrmCheckoutNode>[1],
    kind,
  )
  const node = addNodes.mock.calls[0][0][0]
  const port = node.data.details.quickReplies[1]
  expect(port.label).toBe(
    kind === "receipt"
      ? "supacrmCheckout.skipped"
      : "supacrmCheckout.defaultSkipLabel",
  )
  const changed = configureSupacrmCheckout(node, {
    ...node.data.details.supacrmCheckout,
    prompt: "Changed",
  })
  expect(changed.data.details.quickReplies).toEqual(
    node.data.details.quickReplies,
  )
})
