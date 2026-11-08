// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import {
  OrdinaryMessageForm,
  type OrdinaryMessageFormProps,
} from "../src/features/flows/supacrm-source/message-authoring/ordinary-message-form"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let view: HTMLDivElement
const labels = {
  save: "Сохранить сообщение",
  saving: "Сохранение…",
  saveError: "Изменения не подтверждены. Черновик сохранён.",
  readOnly: "Поле недоступно для редактирования",
}
const props = (): OrdinaryMessageFormProps => ({
  fieldId: "message-field-7",
  label: "Текст сообщения",
  text: "A",
  editable: true,
  pending: false,
  labels,
  onCommit: vi.fn().mockResolvedValue(undefined),
})
async function render(properties = props()) {
  view = document.createElement("div")
  document.body.append(view)
  root = createRoot(view)
  await act(() => root?.render(<OrdinaryMessageForm {...properties} />))
  return properties
}
function input() {
  const element = view.querySelector("textarea")
  if (!element) {
    throw new Error("Нет поля текста")
  }
  return element
}
function save() {
  const element = view.querySelector("button")
  if (!element) {
    throw new Error("Нет кнопки сохранения")
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
afterEach(async () => {
  await act(() => root?.unmount())
  view?.remove()
  vi.unstubAllGlobals()
})

test("контролы доступны человеку и агенту по точной подписи и fieldId", async () => {
  const properties = await render()
  const label = view.querySelector("label")
  expect(input().id).toBe(properties.fieldId)
  expect(input().name).toBe(properties.fieldId)
  expect(label?.htmlFor).toBe(properties.fieldId)
  expect(label?.textContent).toBe(properties.label)
  expect(save().getAttribute("aria-label")).toBe(labels.save)
  expect(save().textContent).toBe(labels.save)
  expect(input().value).toBe("A")
})

test("правка A→B вызывает commit ровно один раз только по явному сохранению", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const properties = await render()
  await type("B")
  expect(properties.onCommit).not.toHaveBeenCalled()
  expect(input().value).toBe("B")
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith("B")
  expect(fetch).not.toHaveBeenCalled()
})

test.each([
  "422",
  "conflict",
  "unconfirmed",
])("ошибка %s сохраняет B без автоматического повтора", async (reason) => {
  const properties = props()
  properties.onCommit = vi.fn().mockRejectedValue(new Error(reason))
  await render(properties)
  await type("B")
  await act(() => save().click())
  expect(input().value).toBe("B")
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(
    labels.saveError,
  )
  expect(properties.onCommit).toHaveBeenCalledExactlyOnceWith("B")
  await act(() =>
    root?.render(<OrdinaryMessageForm {...properties} text="A" />),
  )
  expect(input().value).toBe("B")
})

test("editable=false не выводит значение и не предоставляет путь вызова commit", async () => {
  const properties = {
    ...props(),
    editable: false,
    text: "NEVER_RENDER_THIS",
    readOnlyReason: "Сервер запретил редактирование",
  }
  await render(properties)
  expect(view.querySelector("textarea,input,button")).toBeNull()
  expect(view.textContent).not.toContain(properties.text)
  expect(view.innerHTML).not.toContain(properties.text)
  expect(view.textContent).toContain(properties.readOnlyReason)
  expect(properties.onCommit).not.toHaveBeenCalled()
})

test("pending и два клика в одном событии не создают повторный commit", async () => {
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
  expect(save().getAttribute("aria-label")).toBe(labels.save)
  await act(async () => finish?.())
  await act(() => root?.render(<OrdinaryMessageForm {...properties} pending />))
  expect(save().disabled).toBe(true)
  await act(() => save().click())
  expect(properties.onCommit).toHaveBeenCalledTimes(1)
})

test("смена fieldId сбрасывает черновик и ошибка не раскрывает детали исключения", async () => {
  const properties = props()
  properties.onCommit = vi
    .fn()
    .mockRejectedValue(new Error("SECRET_ERROR_DETAIL"))
  await render(properties)
  await type("B")
  await act(() => save().click())
  expect(view.textContent).not.toContain("SECRET_ERROR_DETAIL")
  await act(() =>
    root?.render(
      <OrdinaryMessageForm {...properties} fieldId="new-field" text="C" />,
    ),
  )
  expect(input().value).toBe("C")
  expect(view.querySelector('[role="alert"]')).toBeNull()
})

test("обычная строка не интерпретируется как HTML", async () => {
  await render({ ...props(), text: "<b>A</b><script>throw 1</script>" })
  expect(input().value).toBe("<b>A</b><script>throw 1</script>")
  expect(view.querySelector("b,script")).toBeNull()
})

test("запрещённое поле без причины показывает переданную локализованную подпись", async () => {
  await render({ ...props(), editable: false })
  expect(view.textContent).toContain(labels.readOnly)
  expect(view.querySelector("textarea,input,button")).toBeNull()
})

test("commitBlocked сохраняет видимый черновик и запрещает новый commit", async () => {
  const properties = await render()
  await type("B")
  await act(() =>
    root?.render(<OrdinaryMessageForm {...properties} commitBlocked />),
  )
  expect(input().value).toBe("B")
  expect(input().disabled).toBe(false)
  expect(save().disabled).toBe(true)
  await act(() => save().click())
  expect(properties.onCommit).not.toHaveBeenCalled()
})

test("dirty callback сравнивает текущую правку с безопасным исходным текстом", async () => {
  const onDirtyChange = vi.fn()
  await render({ ...props(), onDirtyChange })
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  await type("B")
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  await type("A")
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
})
