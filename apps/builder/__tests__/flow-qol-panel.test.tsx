import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"
import { FlowNavigationPanel } from "@/features/flows/react-flow/qol/navigation-panel"
import messages from "../messages/en.json"

const nodes = [
  {
    id: "101",
    type: "sendMessage",
    selected: true,
    data: {
      name: "Каталог Apple",
      editorMetadata: { section: { id: "catalog", title: "Каталог" } },
    },
  },
  { id: "102", type: "condition", data: { name: "Проверка" } },
]

test("searches and focuses original nodes including collapsed section members, and shows distinct connections", async () => {
  const focus = vi.fn()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const changeSearch = async (value: string) => {
    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  try {
    await act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <FlowNavigationPanel
            collapsed={["catalog"]}
            edges={[
              {
                id: "edge-a",
                source: "101",
                target: "102",
                sourceHandle: "button-a",
              },
              {
                id: "edge-b",
                source: "101",
                target: "102",
                sourceHandle: "button-b",
              },
            ]}
            nodes={nodes}
            onAssignSection={vi.fn()}
            onFocus={focus}
            onRemoveSection={vi.fn()}
            onToggleSection={vi.fn()}
          />
        </NextIntlClientProvider>,
      ),
    )
    await changeSearch("APPLE")
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Каталог Apple"),
    )
    expect(button).toBeDefined()
    await act(() => button?.click())
    expect(focus).toHaveBeenCalledWith("101")
    expect(container.textContent).toContain("Каталог Apple → Проверка")
    expect(container.textContent).not.toContain("button-a")
    expect(container.textContent).not.toContain("edge-a")
    expect(
      container.querySelector('[data-edge-id="edge-a"]')?.getAttribute("title"),
    ).toContain("button-a")
    expect(
      container.querySelector('[data-edge-id="edge-b"]')?.getAttribute("title"),
    ).toContain("button-b")
    await changeSearch("no match")
    expect(container.textContent).toContain("No nodes found")
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
