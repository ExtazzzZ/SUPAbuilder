// @vitest-environment jsdom
import { buttonStepDefaultFn } from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { FormProvider, useForm, useWatch } from "react-hook-form"
import { expect, test, vi } from "vitest"
import { ButtonStepEditor, buttonGridStyle } from "../editor"
import { ButtonGroupViewer } from "../viewer"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/base-handle", () => ({ BaseHandle: () => null }))
vi.mock("../../../stores/flow-analytics-store-provider", () => ({
  useFlowAnalyticsStore: () => ({
    isAnalytics: false,
    buttonStats: {},
    totalSent: 0,
  }),
}))
vi.mock("@/components/character-counter", () => ({
  CharacterCounter: () => null,
}))
vi.mock("../../../stores/step-store-provider", () => ({
  useStepStore: () => ({}),
}))

const initial = ["Первая", "Вторая", "Назад"].map((label) =>
  buttonStepDefaultFn({ label }),
)

function Harness() {
  const form = useForm({
    defaultValues: { beforeStep: { channel: "api" }, quickReplies: initial },
  })
  const buttons = useWatch({ control: form.control, name: "quickReplies" })
  return (
    <FormProvider {...form}>
      <ButtonStepEditor parentName="quickReplies.1" />
      <output>
        {JSON.stringify(buttons.map((button) => button.row ?? null))}
      </output>
    </FormProvider>
  )
}

test("редактор объединяет пару, показывает половины и возвращает кнопку на всю строку", () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Harness />))
    const placement = container.querySelector<HTMLButtonElement>(
      "button[aria-pressed]",
    )
    if (!placement) {
      throw new Error("Не найдена кнопка размещения")
    }
    expect(container.querySelector("output")?.textContent).toBe(
      "[null,null,null]",
    )
    act(() => placement.click())
    expect(container.querySelector("output")?.textContent).toBe("[0,0,1]")
    expect(placement.getAttribute("aria-pressed")).toBe("true")
    const paired = initial.map((button, index) => ({
      ...button,
      row: index < 2 ? 0 : 1,
    }))
    expect(buttonGridStyle(paired, 0)).toEqual({ gridColumn: "span 3" })
    expect(buttonGridStyle(paired, 2)).toEqual({ gridColumn: "span 6" })
    act(() => placement.click())
    expect(container.querySelector("output")?.textContent).toBe("[0,1,2]")
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

test("preview показывает две соседние кнопки и отдельную строку для старой кнопки", () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <ButtonGroupViewer
          data={initial.map((button, index) =>
            index < 2 ? { ...button, row: 0 } : button,
          )}
        />,
      ),
    )
    const rows = container.querySelectorAll('[data-slot="button-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelectorAll("button")).toHaveLength(2)
    expect(rows[1]?.textContent).toBe("Назад")
  } finally {
    act(() => root.unmount())
  }
})
