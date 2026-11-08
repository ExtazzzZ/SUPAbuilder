// @vitest-environment jsdom
import {
  createSupacrmVariableNode,
  selectSupacrmVariable,
} from "@chatbotx.io/flow-config"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { SupacrmVariableEditor } from "../src/features/flows/supacrm-variable/variable-editor"

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  updateNodeData: vi.fn(),
  takeSnapshot: vi.fn(),
  setValue: undefined as undefined | ((name: string, value: unknown) => void),
}))
vi.mock("@xyflow/react", () => ({ useReactFlow: () => mocks }))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/features/flows/react-flow/stores/use-flow-history", () => ({
  useFlowHistory: () => mocks,
}))
vi.mock("@chatbotx.io/ui/components/ui/form", async () => {
  const { FormProvider } = await import("react-hook-form")
  return { Form: FormProvider }
})
vi.mock("@chatbotx.io/ui/components/form/input-field", async () => {
  const { useFormContext } = await import("react-hook-form")
  return {
    InputField: ({ name, label }: { name: string; label: string }) => (
      <label>
        {label}
        <input {...useFormContext().register(name)} />
      </label>
    ),
  }
})
vi.mock("@chatbotx.io/ui/components/form/switch-field", async () => {
  const { useFormContext } = await import("react-hook-form")
  return {
    SwitchField: ({ name, label }: { name: string; label: string }) => (
      <label>
        {label}
        <input type="checkbox" {...useFormContext().register(name)} />
      </label>
    ),
  }
})
vi.mock("@chatbotx.io/ui/components/form/input-number-field", async () => {
  const { useFormContext } = await import("react-hook-form")
  return {
    InputNumberField: ({ name, label }: { name: string; label: string }) => (
      <label>
        {label}
        <input
          type="number"
          {...useFormContext().register(name, { valueAsNumber: true })}
        />
      </label>
    ),
  }
})
vi.mock("@chatbotx.io/ui/components/form/textarea-field", async () => {
  const { useFormContext } = await import("react-hook-form")
  return {
    TextareaField: ({ name, label }: { name: string; label: string }) => {
      const form = useFormContext()
      mocks.setValue = form.setValue
      return (
        <label>
          {label}
          <textarea {...form.register(name)} />
        </label>
      )
    },
  }
})
vi.mock("@chatbotx.io/ui/components/form/select-field", async () => {
  const { useFormContext } = await import("react-hook-form")
  return {
    SelectField: ({
      name,
      options,
    }: {
      name: string
      options: { value: string; label: string }[]
    }) => (
      <select {...useFormContext().register(name)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  }
})
vi.mock("@chatbotx.io/ui/components/ui/button", () => ({
  Button: ({ children, type }: { children: ReactNode; type: "submit" }) => (
    <button type={type}>{children}</button>
  ),
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const submit = async () =>
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })

test("редактор компилирует literal template без раскрытия текущего значения", async () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "Язык {{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  await submit()
  const data = mocks.updateNodeData.mock.calls[0][1]
  expect(data.details.supacrmVariable.payload).toEqual({
    key: "language",
    template: "Язык {{value}}",
  })
  expect(data.details.steps[0].id).toBe(node.data.details.steps[0].id)
  expect(container.textContent).not.toContain("SUPACRM_ACTION_V1")
})

test("advanced set сохраняет boolean и показывает требование перечитывания CAS", async () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.set",
    payload: {
      key: "language",
      value: false,
      expected_revision: 2,
      source_fingerprint: "f".repeat(64),
      confirmation: "Изменено",
    },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  expect(container.textContent).toContain("supacrmVariable.casWarning")
  await submit()
  expect(
    mocks.updateNodeData.mock.calls[0][1].details.supacrmVariable.payload.value,
  ).toBe(false)
})

test("пустой ключ не заменяет node и показывает безопасную ошибку", async () => {
  const node = createSupacrmVariableNode({})
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  await submit()
  expect(mocks.updateNodeData).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "supacrmVariable.invalid",
  )
})

test.each([
  "Нет подстановки",
  "{{value}} {{value}}",
])("редактор не сохраняет шаблон %s", async (template) => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "{{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => mocks.setValue?.("template", template))
  await submit()
  expect(mocks.updateNodeData).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "supacrmVariable.invalid",
  )
})

test.each([
  "then_text",
  "else_text",
])("редактор не сохраняет пустой %s", async (field) => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.condition",
    payload: {
      key: "language",
      operator: "eq",
      operand: false,
      then_text: "Да",
      else_text: "Нет",
    },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => mocks.setValue?.(field, ""))
  await submit()
  expect(mocks.updateNodeData).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "supacrmVariable.invalid",
  )
})

test.each([
  "variables.set",
  "variables.reset",
])("новое действие %s по умолчанию использует autoCAS", async (action) => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "{{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => {
    mocks.setValue?.("action", action)
    mocks.setValue?.("confirmation", "Готово")
  })
  expect(container.querySelector('[name="expected_revision"]')).toBeNull()
  await submit()
  expect(
    mocks.updateNodeData.mock.calls[0][1].details.supacrmVariable.payload,
  ).toEqual({
    key: "language",
    confirmation: "Готово",
    ...(action === "variables.set" ? { value: null } : {}),
  })
})

test("set проверенного входящего текста не сериализует literal и не разбирает его JSON", async () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "{{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => {
    mocks.setValue?.("action", "variables.set")
    mocks.setValue?.("value_from", "inbound_text")
    mocks.setValue?.("value", "не JSON")
    mocks.setValue?.("confirmation", "Готово")
  })
  expect(container.querySelector('[name="value"]')).toBeNull()
  await submit()
  expect(
    mocks.updateNodeData.mock.calls[0][1].details.supacrmVariable.payload,
  ).toEqual({
    key: "language",
    value_from: "inbound_text",
    confirmation: "Готово",
  })
})

test("advanced toggle добавляет только полную явную CAS пару и удаляет её при выключении", async () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "{{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => {
    mocks.setValue?.("action", "variables.set")
    mocks.setValue?.("confirmation", "Готово")
    mocks.setValue?.("explicit_cas", true)
  })
  expect(container.querySelector('[name="expected_revision"]')).not.toBeNull()
  await submit()
  expect(mocks.updateNodeData).not.toHaveBeenCalled()
  act(() => mocks.setValue?.("source_fingerprint", "f".repeat(64)))
  await submit()
  expect(
    mocks.updateNodeData.mock.calls[0][1].details.supacrmVariable.payload,
  ).toEqual({
    key: "language",
    confirmation: "Готово",
    value: null,
    expected_revision: 0,
    source_fingerprint: "f".repeat(64),
  })
  act(() => mocks.setValue?.("explicit_cas", false))
  await submit()
  expect(
    mocks.updateNodeData.mock.calls[1][1].details.supacrmVariable.payload,
  ).toEqual({ key: "language", confirmation: "Готово", value: null })
})

test.each([
  "1e999",
  '{"nested":1e999}',
])("literal JSON не допускает нечисловой результат %s", async (value) => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), {
    action: "variables.render",
    payload: { key: "language", template: "{{value}}" },
  })
  mocks.getNode.mockReturnValue(node)
  await act(async () =>
    root.render(
      <SupacrmVariableEditor
        nodeDetails={node.data.details}
        nodeId={node.id}
      />,
    ),
  )
  act(() => {
    mocks.setValue?.("action", "variables.set")
    mocks.setValue?.("confirmation", "Готово")
    mocks.setValue?.("value", value)
  })
  await submit()
  expect(mocks.updateNodeData).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})
