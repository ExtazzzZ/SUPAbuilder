// @vitest-environment jsdom
import { createSupacrmReminderNode } from "@chatbotx.io/flow-config"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import ru from "../messages/ru.json"
import { SupacrmReminderEditor } from "../src/features/flows/supacrm-reminder/reminder-editor"

const h = vi.hoisted(() => ({
  getNode: vi.fn(),
  updateNodeData: vi.fn(),
  takeSnapshot: vi.fn(),
}))
vi.mock("@xyflow/react", () => ({ useReactFlow: () => h }))
vi.mock("@/features/flows/react-flow/stores/use-flow-history", () => ({
  useFlowHistory: () => h,
}))
it("renders Russian form and saves typed settings with existing handles", async () => {
  const node = createSupacrmReminderNode({})
  h.getNode.mockReturnValue(node)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(() =>
      root.render(
        <NextIntlClientProvider locale="ru" messages={ru}>
          <SupacrmReminderEditor
            nodeDetails={node.data.details}
            nodeId={node.id}
          />
        </NextIntlClientProvider>,
      ),
    )
    expect(host.textContent).toContain("Событие-якорь")
    expect(host.querySelectorAll("textarea")).toHaveLength(1)
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        )
      await Promise.resolve()
    })
    expect(h.updateNodeData).toHaveBeenCalledOnce()
    expect(h.updateNodeData.mock.calls[0][1].details.quickReplies).toEqual(
      node.data.details.quickReplies,
    )
  } finally {
    await act(() => root.unmount())
    host.remove()
  }
})
