// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import {
  SwitchCaseValueForm,
  type SwitchCaseValueFormProps,
} from "../src/features/flows/supacrm-source/switch-authoring/switch-case-value-form"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const labels = {
  title: "Значение существующего варианта",
  value: "Строковое значение варианта",
  caseId: "ID варианта",
  position: "Исходный индекс",
  port: "Исходный порт",
  name: "Имя порта",
  unnamedPort: "Без имени (null)",
  target: "Целевой блок",
  terminal: "Завершение (null)",
  path: "Исходный путь",
  sequence: "Порядковый номер порта",
  scenario: "Сценарий",
  block: "Блок",
  save: "Сохранить значение",
  saving: "Сохранение",
  saveError: "Изменение не подтверждено, черновик сохранён",
  readOnly: "Редактирование запрещено",
}
const props = (): SwitchCaseValueFormProps => ({
  caseId: "opaque-case-7",
  position: 3,
  port: {
    scenario_id: "scenario",
    block_id: "switch",
    source_path: "params.cases[3].transition",
    sequence: 4,
    name: null,
    target_block_id: null,
  },
  text: "A",
  editable: true,
  pending: false,
  labels,
  onCommit: vi.fn().mockResolvedValue(undefined),
})
let root: Root | undefined
let view: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  view?.remove()
  vi.unstubAllGlobals()
})
async function render(properties = props()) {
  view = document.createElement("div")
  document.body.append(view)
  root = createRoot(view)
  await act(() => root?.render(<SwitchCaseValueForm {...properties} />))
  return properties
}
function input() {
  const element = view.querySelector("textarea")
  if (!element) {
    throw new Error("Нет поля значения")
  }
  return element
}
function save() {
  const element = view.querySelector("button")
  if (!element) {
    throw new Error("Нет сохранения")
  }
  return element
}
async function type(text: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input(), text)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

test("показывает точные case ID, индекс и provenance порта только для чтения", async () => {
  const properties = await render()
  expect(
    view.querySelector("[data-case-id]")?.getAttribute("data-case-id"),
  ).toBe(properties.caseId)
  expect(
    view
      .querySelector("[data-case-position]")
      ?.getAttribute("data-case-position"),
  ).toBe("3")
  for (const value of [
    properties.caseId,
    "scenario",
    "switch",
    "params.cases[3].transition",
    "4",
  ]) {
    expect(view.textContent).toContain(value)
  }
  expect(view.querySelector("select")).toBeNull()
  expect(view.querySelectorAll("button")).toHaveLength(1)
  expect(view.querySelectorAll("textarea")).toHaveLength(1)
  expect(
    view.querySelector('input[name="target"],input[name="position"]'),
  ).toBeNull()
})

test("null имя и terminal null отображаются отдельно от строки null", async () => {
  const properties = await render()
  expect(view.textContent).toContain(labels.unnamedPort)
  expect(view.textContent).toContain(labels.terminal)
  expect(
    view
      .querySelector("[data-port-name-kind]")
      ?.getAttribute("data-port-name-kind"),
  ).toBe("null")
  expect(
    view
      .querySelector("[data-port-target-kind]")
      ?.getAttribute("data-port-target-kind"),
  ).toBe("null")
  await act(() =>
    root?.render(
      <SwitchCaseValueForm
        {...properties}
        port={{ ...properties.port, name: "null", target_block_id: "null" }}
      />,
    ),
  )
  expect(view.textContent).not.toContain(labels.unnamedPort)
  expect(view.textContent).not.toContain(labels.terminal)
  expect(view.textContent).toContain("«null»")
  expect(
    view
      .querySelector("[data-port-name-kind]")
      ?.getAttribute("data-port-name-kind"),
  ).toBe("string")
  expect(
    view
      .querySelector("[data-port-target-kind]")
      ?.getAttribute("data-port-target-kind"),
  ).toBe("string")
})

test("человек и агент находят обычное строковое поле по label и стабильному case ID", async () => {
  const properties = await render()
  const label = view.querySelector("label")
  expect(label?.textContent).toBe(labels.value)
  expect(label?.htmlFor).toBe(input().id)
  expect(input().id).toContain(properties.caseId)
  expect(input().name).toBe(input().id)
  expect(save().getAttribute("aria-label")).toBe(labels.save)
})

test("A→B не вычисляет switch и вызывает commit только по явному Save", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const properties = await render()
  await type("B")
  expect(properties.onCommit).not.toHaveBeenCalled()
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith("B")
  expect(properties.port).toEqual(props().port)
  expect(properties.position).toBe(3)
  expect(fetch).not.toHaveBeenCalled()
})

test.each([
  "validation_rejected",
  "conflict",
  "unconfirmed",
])("отказ %s сохраняет B и metadata варианта", async (reason) => {
  const properties = props()
  properties.onCommit = vi.fn().mockRejectedValue(new Error(reason))
  await render(properties)
  await type("B")
  await act(() => save().click())
  expect(input().value).toBe("B")
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    labels.saveError,
  )
  expect(view.textContent).toContain(properties.port.source_path)
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith("B")
  await act(() =>
    root?.render(<SwitchCaseValueForm {...properties} commitBlocked />),
  )
  expect(input().value).toBe("B")
  expect(input().disabled).toBe(false)
  expect(save().disabled).toBe(true)
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledTimes(1)
})

test("editable false не помещает значение в DOM и не предоставляет commit control", async () => {
  const properties = {
    ...props(),
    editable: false,
    text: "DO_NOT_REVEAL",
    readOnlyReason: "Поле не одобрено сервером",
  }
  await render(properties)
  expect(view.innerHTML).not.toContain(properties.text)
  expect(view.querySelector("textarea,input,button")).toBeNull()
  expect(view.textContent).toContain(properties.readOnlyReason)
  expect(properties.onCommit).not.toHaveBeenCalled()
})

test("pending и двойной click не создают повторов сохранения", async () => {
  let finish: (() => void) | undefined
  const properties = props()
  properties.onCommit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await render(properties)
  await type("B")
  await act(() => {
    save().click()
    save().click()
  })
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith("B")
  expect(save().disabled).toBe(true)
  expect(input().disabled).toBe(true)
  await act(async () => finish?.())
  await act(() => root?.render(<SwitchCaseValueForm {...properties} pending />))
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledTimes(1)
})

test("dirty отражает только текстовую правку, marker остаётся строкой", async () => {
  const onDirtyChange = vi.fn()
  const properties = { ...props(), onDirtyChange }
  await render(properties)
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  const marker = "{{value}} <script>throw 1</script>"
  await type(marker)
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect(view.querySelector("script")).toBeNull()
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith(marker)
  await type("A")
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
})

test("смена case ID не переносит черновик предыдущего варианта", async () => {
  const properties = await render()
  await type("B")
  await act(() =>
    root?.render(
      <SwitchCaseValueForm {...properties} caseId="different-case" text="C" />,
    ),
  )
  expect(input().value).toBe("C")
  expect(input().id).toContain("different-case")
})
