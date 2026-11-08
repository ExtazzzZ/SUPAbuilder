// @vitest-environment jsdom
import type { SourceProjection } from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { SupacrmSourceEditor } from "../src/features/flows/supacrm-source/source-editor"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const fixture = (): SourceProjection => ({
  version: "supacrm.source-projection.v1",
  sourceRevision: "synthetic-revision",
  nodes: [
    {
      sourceId: "source-1",
      kind: "send_message",
      label: "Сообщение",
      ports: [
        { id: "yes", label: "Да" },
        { id: "no", label: "Нет" },
      ],
      bindings: [],
      content: {
        richText: "Привет",
        editMode: "edit",
        buttons: [{ id: "button-1", label: "Да", portId: "yes" }],
        media: [{ id: "media-1", kind: "image", assetRef: "asset:synthetic" }],
      },
      position: { x: 1, y: 2 },
    },
  ],
  edges: [],
  symbols: Array.from({ length: 40 }, (_, index) => ({
    id: `symbol-${index}`,
    name: `Переменная ${index}`,
    scope: "user",
    valueType: "str",
    owner: "profile",
    policy: "state",
    operations: ["read", "set", "reset"],
  })),
})
function required<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error("Не найден элемент синтетической проверки")
  }
  return value
}

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
})
const render = async (
  projection = fixture(),
  options: { showMessageDraft?: boolean } = {},
) => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const onChange = vi.fn()
  const onPublish = vi.fn()
  await act(() =>
    root?.render(
      <SupacrmSourceEditor
        onChange={onChange}
        onPublish={onPublish}
        projection={projection}
        {...options}
      />,
    ),
  )
  return { onChange, onPublish, view: container }
}

test("показывает полный registry metadata и исходные порты без значений", async () => {
  const { view } = await render()
  const registry = view.querySelector<HTMLSelectElement>(
    'select[name="symbolId"]',
  )
  expect(registry?.options.length).toBe(41)
  expect(view.textContent).toContain("symbol-39")
  expect(view.textContent).toContain("yes")
  expect(view.textContent).toContain("no")
  expect(view.querySelector('input[name="value"]')).toBeNull()
  expect(view.querySelector('input[name="credentials"]')).toBeNull()
})

test("правка подписи сохраняет IDs, кнопки, media и исходный edit mode", async () => {
  const original = fixture()
  const { view, onChange } = await render(original)
  const input = required(
    view.querySelector<HTMLInputElement>('input[name="label"]'),
  )
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Новая подпись")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0]?.[0].nodes[0]).toEqual({
    ...original.nodes[0],
    label: "Новая подпись",
  })
})

test("выбор символа разрешает только операции metadata policy", async () => {
  const original = fixture()
  original.symbols[0] = {
    ...required(original.symbols[0]),
    policy: "read_only",
    operations: ["read"],
  }
  const { view, onChange } = await render(original)
  const select = required(
    view.querySelector<HTMLSelectElement>('select[name="symbolId"]'),
  )
  await act(() => {
    select.value = "symbol-0"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const operation = required(
    view.querySelector<HTMLSelectElement>('select[name="operation"]'),
  )
  expect(Array.from(operation.options).map((option) => option.value)).toEqual([
    "read",
  ])
  const add = required(
    view.querySelector<HTMLButtonElement>('button[data-action="add-binding"]'),
  )
  await act(() => add.click())
  expect(onChange.mock.calls[0]?.[0].nodes[0].bindings).toEqual([
    { symbolId: "symbol-0", operation: "read" },
  ])
})

test("диагностика компиляции запрещает публикацию без исполнения внешних действий", async () => {
  const original = fixture()
  required(original.nodes[0]).bindings = [
    { symbolId: "missing", operation: "set" },
  ]
  const fetchSpy = vi.spyOn(globalThis, "fetch")
  const { view, onPublish } = await render(original)
  expect(view.querySelector('[role="alert"]')).not.toBeNull()
  const publish = required(
    view.querySelector<HTMLButtonElement>('button[data-action="publish"]'),
  )
  expect(publish.disabled).toBe(true)
  await act(() => publish.click())
  expect(onPublish).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
})

test("секретные metadata видны без разрешения добавлять обращение", async () => {
  const original = fixture()
  original.symbols[0] = {
    ...required(original.symbols[0]),
    policy: "secret_ref",
    operations: ["read"],
  }
  const { view, onChange } = await render(original)
  const select = required(
    view.querySelector<HTMLSelectElement>('select[name="symbolId"]'),
  )
  await act(() => {
    select.value = "symbol-0"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const add = required(
    view.querySelector<HTMLButtonElement>('button[data-action="add-binding"]'),
  )
  expect(add.disabled).toBe(true)
  await act(() => add.click())
  expect(onChange).not.toHaveBeenCalled()
})

test("чистая публикация возвращает проверенную проекцию без внешнего запроса", async () => {
  const original = fixture()
  const { view, onPublish } = await render(original)
  const publish = required(
    view.querySelector<HTMLButtonElement>('button[data-action="publish"]'),
  )
  expect(publish.disabled).toBe(false)
  await act(() => publish.click())
  expect(onPublish).toHaveBeenCalledWith(original)
})

test("удаление обращения сохраняет соседнее обращение", async () => {
  const original = fixture()
  required(original.nodes[0]).bindings = [
    { symbolId: "symbol-0", operation: "read" },
    { symbolId: "symbol-1", operation: "set" },
  ]
  const { view, onChange } = await render(original)
  const remove = required(
    Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "removeBinding",
    ),
  )
  await act(() => remove.click())
  expect(onChange.mock.calls[0]?.[0].nodes[0].bindings).toEqual([
    { symbolId: "symbol-1", operation: "set" },
  ])
})

test("редактирование текста не теряет кнопки и медиассылки", async () => {
  const original = fixture()
  const { view, onChange } = await render(original)
  const input = required(
    view.querySelector<HTMLTextAreaElement>('textarea[name="richText"]'),
  )
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "Новый текст")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(onChange.mock.calls[0]?.[0].nodes[0].content).toEqual({
    ...required(original.nodes[0]).content,
    richText: "Новый текст",
  })
})

test("выбор edit mode не меняет содержимое", async () => {
  const original = fixture()
  const { view, onChange } = await render(original)
  const input = required(
    view.querySelector<HTMLSelectElement>('select[name="editMode"]'),
  )
  await act(() => {
    input.value = "replace"
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(onChange.mock.calls[0]?.[0].nodes[0].content).toEqual({
    ...required(original.nodes[0]).content,
    editMode: "replace",
  })
})

test("не раскрывает отклонённые поля из schema error в диагностике", async () => {
  const original = { ...fixture(), credentials: "synthetic-forbidden-value" }
  const { view } = await render(original)
  expect(view.querySelector('[role="alert"]')?.textContent).toContain(
    "invalid_projection",
  )
  expect(view.textContent).not.toContain("synthetic-forbidden-value")
  expect(
    required(
      view.querySelector<HTMLButtonElement>('button[data-action="publish"]'),
    ).disabled,
  ).toBe(true)
})

test("показывает все безопасные поля declaration и фильтрует операции native owner", async () => {
  const original = fixture()
  original.symbols[0] = {
    ...required(original.symbols[0]),
    policy: "native_command",
    operations: ["read", "set", "command"],
    declaration: {
      rawKey: "Счётчик",
      definitionRevision: "def-v1",
      protected: true,
      lifetime: "run",
      defaultPolicy: "reference",
      sensitivity: "protected",
      readStrategy: "projection",
      writeStrategy: "command",
      resetPolicy: "context",
      units: "шт",
    },
  }
  const { view } = await render(original)
  const select = required(
    view.querySelector<HTMLSelectElement>('select[name="symbolId"]'),
  )
  await act(() => {
    select.value = "symbol-0"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const details = required(view.querySelector("dl"))
  expect(details.querySelectorAll("dt")).toHaveLength(10)
  expect(details.textContent).toContain("def-v1")
  expect(details.textContent).toContain("шт")
  const operation = required(
    view.querySelector<HTMLSelectElement>('select[name="operation"]'),
  )
  expect(Array.from(operation.options).map((option) => option.value)).toEqual([
    "read",
    "command",
  ])
  await act(() => {
    operation.value = "command"
    operation.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(operation.value).toBe("command")
})

test("пустой граф остаётся доступен для диагностики без попытки исполнения", async () => {
  const original = fixture()
  original.nodes = []
  const { view } = await render(original)
  expect(view.querySelector('input[name="label"]')).toBeNull()
})

test("контролируемый выбор canvas открывает нужный исходный блок без изменения его ID", async () => {
  const original = fixture()
  original.nodes.push({
    ...required(original.nodes[0]),
    sourceId: "source-2",
    label: "Второй блок",
    ports: [],
    content: { richText: "Второй текст" },
  })
  const { view } = await render(original)
  const onSelectSource = vi.fn()
  await act(() =>
    root?.render(
      <SupacrmSourceEditor
        onChange={vi.fn()}
        onSelectSource={onSelectSource}
        projection={original}
        selectedSourceId="source-2"
      />,
    ),
  )
  expect(
    required(view.querySelector<HTMLInputElement>('input[name="label"]')).value,
  ).toBe("Второй блок")
  const select = required(
    view.querySelector<HTMLSelectElement>('select[name="sourceId"]'),
  )
  await act(() => {
    select.value = "source-1"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(onSelectSource).toHaveBeenCalledWith("source-1")
  expect(
    required(view.querySelector<HTMLInputElement>('input[name="label"]')).value,
  ).toBe("Второй блок")
})

test("без флага обычные message draft controls остаются доступными", async () => {
  const { view } = await render()
  expect(
    view.querySelector<HTMLTextAreaElement>('textarea[name="richText"]')?.value,
  ).toBe("Привет")
  expect(
    view.querySelector<HTMLSelectElement>('select[name="editMode"]')?.value,
  ).toBe("edit")
})

test.each([
  true,
  false,
])("showMessageDraft=false скрывает draft без fallback при populated=%s, сохраняя metadata", async (populated) => {
  const original = fixture()
  if (!populated) {
    required(original.nodes[0]).content = {}
  }
  const { view, onChange } = await render(original, { showMessageDraft: false })
  expect(view.querySelector('textarea[name="richText"]')).toBeNull()
  expect(view.querySelector('select[name="editMode"]')).toBeNull()
  expect(view.querySelector('input[name="label"]')).not.toBeNull()
  expect(view.querySelector('select[name="sourceId"]')).not.toBeNull()
  expect(
    view.querySelector<HTMLSelectElement>('select[name="symbolId"]')?.options
      .length,
  ).toBe(41)
  expect(view.textContent).toContain("yes")
  expect(view.textContent).toContain("no")
  expect(view.textContent).toContain("symbol-39")
  expect(view.innerHTML).not.toContain("Привет")
  expect(onChange).not.toHaveBeenCalled()
  const label = required(
    view.querySelector<HTMLInputElement>('input[name="label"]'),
  )
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(label, "Обновлённая подпись")
    label.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(onChange.mock.calls[0]?.[0].nodes[0].content).toEqual(
    required(original.nodes[0]).content,
  )
})
