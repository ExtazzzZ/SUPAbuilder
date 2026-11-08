// @vitest-environment jsdom
import type {
  SourceLogicProjectionV1,
  SourceProjection,
  SourceTypedExprV1,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { SourceLogicEditor } from "../src/features/flows/supacrm-source/logic-editor"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const slot: SourceTypedExprV1 = {
  kind: "literal_slot",
  slot_id: "opaque-slot",
  declared_type: "num",
}
const symbol: SourceTypedExprV1 = { kind: "symbol", symbol_id: "state" }
const hash = "a".repeat(64)
const span = {
  scenario_id: "scenario",
  block_id: "one",
  path: "data.condition",
  start: 12,
  end: 20,
  sequence: 3,
}
const fixture = (): SourceLogicProjectionV1 => ({
  dto_version: "1.0.0",
  source_hash: hash,
  publishable: false,
  diagnostics: [],
  edits: [
    {
      kind: "guard",
      expected_source_hash: hash,
      target: span,
      expression: { kind: "binary", operator: ">", left: symbol, right: slot },
    },
    {
      kind: "assignment",
      expected_source_hash: hash,
      target: { ...span, path: "data.variables" },
      symbol_id: "state",
      mode: "set",
      operands: [slot],
    },
    {
      kind: "transition",
      expected_source_hash: hash,
      target: { ...span, path: "data.next" },
      port: {
        scenario_id: "scenario",
        block_id: "one",
        source_path: "next",
        name: null,
        target_block_id: "two",
        sequence: 0,
      },
      target_block_id: "two",
    },
  ],
})
const projection: SourceProjection = {
  version: "supacrm.source-projection.v1",
  sourceRevision: "revision",
  edges: [],
  nodes: ["one", "two", "three"].map((id) => ({
    sourceId: id,
    scenarioId: "scenario",
    kind: "basic",
    label: id,
    ports: [],
    bindings: [],
    content: {},
    position: { x: 0, y: 0 },
  })),
  symbols: [
    {
      id: "state",
      name: "Состояние",
      scope: "user",
      valueType: "num",
      owner: "profile",
      policy: "state",
      operations: ["read", "set"],
    },
    {
      id: "other",
      name: "Другое состояние",
      scope: "user",
      valueType: "num",
      owner: "profile",
      policy: "state",
      operations: ["read", "set"],
    },
    {
      id: "secret",
      name: "Секрет",
      scope: "project",
      valueType: "str",
      owner: "vault",
      policy: "secret_ref",
      operations: ["read"],
    },
    {
      id: "command",
      name: "Команда",
      scope: "builtin",
      valueType: "num",
      owner: "native",
      policy: "native_command",
      operations: ["read", "command"],
    },
  ],
}
let root: Root | undefined
let view: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  view?.remove()
  vi.unstubAllGlobals()
})
async function render(logic = fixture()) {
  view = document.createElement("div")
  document.body.append(view)
  root = createRoot(view)
  const onChange = vi.fn()
  await act(() =>
    root?.render(
      <SourceLogicEditor
        logic={logic}
        onChange={onChange}
        projection={projection}
      />,
    ),
  )
  return onChange
}
function select(name: string) {
  const element = view.querySelector<HTMLSelectElement>(
    `select[name="${name}"]`,
  )
  if (!element) {
    throw new Error(`Не найдено поле ${name}`)
  }
  return element
}
async function change(name: string, value: string) {
  await act(() => {
    const element = select(name)
    element.value = value
    element.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

test("правка guard сохраняет literal_slot, span и hash без сетевых вызовов", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const original = fixture()
  const onChange = await render(original)
  await change("edits.0.expression.operator", "==")
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0]?.[0]).toEqual({
    ...original,
    edits: [
      {
        ...original.edits[0],
        expression: {
          kind: "binary",
          operator: "==",
          left: symbol,
          right: slot,
        },
      },
      ...original.edits.slice(1),
    ],
  })
  expect(fetch).not.toHaveBeenCalled()
  expect(view.textContent).toContain("data.condition")
  expect(view.textContent).toContain(hash)
})

test("присваивание разрешает только state+set, чтение исключает secret", async () => {
  const original = fixture()
  const onChange = await render(original)
  expect(
    Array.from(select("edits.1.symbol_id").options).map(
      (option) => option.value,
    ),
  ).toEqual(["state", "other"])
  expect(
    Array.from(select("edits.0.expression.left.symbol_id").options).map(
      (option) => option.value,
    ),
  ).toEqual(["state", "other", "command"])
  expect(view.textContent).not.toContain("Секрет")
  await change("edits.1.mode", "+")
  expect(onChange.mock.calls[0]?.[0].edits[1]).toEqual({
    ...original.edits[1],
    mode: "+",
  })
  expect(original.edits[1]).toMatchObject({ mode: "set", operands: [slot] })
})

test("переход использует все блоки и explicit null, сохраняя исходный port", async () => {
  const original = fixture()
  const onChange = await render(original)
  expect(
    Array.from(select("edits.2.target_block_id").options).map(
      (option) => option.value,
    ),
  ).toEqual(["terminal", "block:one", "block:two", "block:three"])
  await change("edits.2.target_block_id", "terminal")
  expect(onChange.mock.calls[0]?.[0].edits[2]).toEqual({
    ...original.edits[2],
    target_block_id: null,
  })
  await change("edits.2.target_block_id", "block:three")
  expect(onChange.mock.calls[1]?.[0].edits[2]).toEqual({
    ...original.edits[2],
    target_block_id: "three",
  })
})

test("отсутствующая цель не превращается в terminal при отображении", async () => {
  const logic = fixture()
  const transition = logic.edits[2]
  if (transition?.kind !== "transition") {
    throw new Error("Нет перехода")
  }
  Reflect.deleteProperty(transition, "target_block_id")
  const onChange = await render(logic)
  expect(select("edits.2.target_block_id").value).toBe("missing")
  expect(onChange).not.toHaveBeenCalled()
})

const variants: SourceTypedExprV1[] = [
  symbol,
  slot,
  { kind: "local", parameter_id: "x" },
  { kind: "unary", operator: "not", operand: symbol },
  { kind: "binary", operator: "+", left: symbol, right: slot },
  { kind: "call", function_id: "registered_function", arguments: [slot] },
  {
    kind: "conditional",
    condition: symbol,
    when_true: slot,
    when_false: symbol,
  },
  { kind: "list", items: [slot] },
  { kind: "tuple", items: [symbol] },
  { kind: "dict", entries: [{ key: slot, value: symbol }] },
  { kind: "index", collection: symbol, index: slot },
  {
    kind: "lambda",
    parameters: [{ kind: "local", parameter_id: "x" }],
    body: { kind: "local", parameter_id: "x" },
  },
]
test.each(
  variants,
)("форма AST $kind отображается и сохраняется при независимой правке", async (expression) => {
  const original = fixture()
  const guard = original.edits[0]
  if (guard?.kind !== "guard") {
    throw new Error("Нет условия")
  }
  guard.expression = expression
  const onChange = await render(original)
  expect(
    view.querySelector(`[data-expression-kind="${expression.kind}"]`),
  ).not.toBeNull()
  expect(onChange).not.toHaveBeenCalled()
  await change("edits.2.target_block_id", "terminal")
  expect(onChange.mock.calls[0]?.[0].edits[0]).toEqual(guard)
  expect(view.querySelector("textarea")).toBeNull()
  expect(view.querySelector('input[name="value"]')).toBeNull()
})

test("слоты выбираются только из исходных handles с неизменным declared_type", async () => {
  const onChange = await render()
  expect(
    Array.from(select("edits.1.operands.0.slot_id").options).map(
      (option) => option.textContent,
    ),
  ).toEqual(["opaque-slot · num"])
  await change("edits.1.operands.0.slot_id", "0")
  expect(onChange.mock.calls[0]?.[0].edits[1].operands).toEqual([slot])
  expect(view.querySelector('input[name$="slot_id"]')).toBeNull()
})

test.each(
  variants,
)("изменения полей AST $kind сохраняют provenance и не создают значения литералов", async (expression) => {
  const original = fixture()
  const guard = original.edits[0]
  if (guard?.kind !== "guard") {
    throw new Error("Нет условия")
  }
  guard.expression = expression
  const onChange = await render(original)
  const expressionView = view.querySelector("[data-expression-kind]")
  if (!expressionView) {
    throw new Error("Нет формы выражения")
  }
  for (const element of Array.from(expressionView.querySelectorAll("select"))) {
    for (const option of Array.from(element.options)) {
      if (option.disabled) {
        continue
      }
      await act(() => {
        element.value = option.value
        element.dispatchEvent(new Event("change", { bubbles: true }))
      })
    }
  }
  for (const input of Array.from(expressionView.querySelectorAll("input"))) {
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "updated_identifier")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  for (const button of Array.from(expressionView.querySelectorAll("button"))) {
    if (!button.disabled) {
      await act(() => button.click())
    }
  }
  expect(onChange).toHaveBeenCalled()
  for (const [updated] of onChange.mock.calls) {
    expect(updated.source_hash).toBe(hash)
    expect(updated.publishable).toBe(false)
    expect(updated.edits[0].target).toEqual(span)
    expect(updated.edits[0].expected_source_hash).toBe(hash)
    expect(updated.edits.slice(1)).toEqual(original.edits.slice(1))
    expect(JSON.stringify(updated)).not.toContain('"literal":')
    expect(JSON.stringify(updated)).not.toContain('"vault_ref":')
  }
})

test("присваивание сохраняет исходные операнды и ограничивает их число двумя", async () => {
  const original = fixture()
  const onChange = await render(original)
  await change("edits.1.symbol_id", "other")
  expect(onChange.mock.calls[0]?.[0].edits[1]).toEqual({
    ...original.edits[1],
    symbol_id: "other",
  })
  const assignment = select("edits.1.mode").closest("fieldset")
  const add = Array.from(assignment?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent === "add",
  )
  if (!add) {
    throw new Error("Нет добавления операнда")
  }
  await act(() => add.click())
  expect(onChange.mock.calls[1]?.[0].edits[1].operands).toEqual([slot, slot])
  const updated = onChange.mock.calls[1]?.[0]
  await act(() =>
    root?.render(
      <SourceLogicEditor
        logic={updated}
        onChange={onChange}
        projection={projection}
      />,
    ),
  )
  const buttons =
    select("edits.1.mode").closest("fieldset")?.querySelectorAll("button") ?? []
  expect(
    Array.from(buttons).find((button) => button.textContent === "add")
      ?.disabled,
  ).toBe(true)
  const remove = Array.from(buttons).find(
    (button) => button.textContent === "remove",
  )
  if (!remove) {
    throw new Error("Нет удаления операнда")
  }
  await act(() => remove.click())
  expect(onChange.mock.calls[2]?.[0].edits[1].operands).toEqual([slot])
})

test("пустая проекция и недоступные символы не получают скрытых авторских правок", async () => {
  const logic = fixture()
  const onChange = await render(logic)
  await act(() =>
    root?.render(
      <SourceLogicEditor
        logic={{ ...logic, edits: [] }}
        onChange={onChange}
        projection={{ ...projection, symbols: [] }}
      />,
    ),
  )
  expect(view.textContent).toContain("empty")
  expect(onChange).not.toHaveBeenCalled()
  await act(() =>
    root?.render(
      <SourceLogicEditor
        logic={logic}
        onChange={onChange}
        projection={{ ...projection, symbols: [] }}
      />,
    ),
  )
  expect(select("edits.1.symbol_id").selectedOptions[0]?.disabled).toBe(true)
  expect(
    select("edits.0.expression.left.symbol_id").selectedOptions[0]?.disabled,
  ).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

test("последний literal_slot можно восстановить после замены без потери других правок", async () => {
  const initial = fixture()
  const guard = initial.edits[0]
  const assignment = initial.edits[1]
  if (guard?.kind !== "guard" || assignment?.kind !== "assignment") {
    throw new Error("Нет исходных правок")
  }
  guard.expression = slot
  assignment.operands = [symbol]
  const onChange = await render(initial)
  const rerenderLatest = async () => {
    const latest = onChange.mock.lastCall?.[0]
    if (!latest) {
      throw new Error("Нет новой проекции")
    }
    await act(() =>
      root?.render(
        <SourceLogicEditor
          logic={latest}
          onChange={onChange}
          projection={projection}
        />,
      ),
    )
  }
  await change("edits.1.mode", "+")
  await rerenderLatest()
  await change("edits.0.expression.kind", "symbol")
  await rerenderLatest()
  expect(
    Array.from(select("edits.0.expression.kind").options).find(
      (option) => option.value === "literal_slot",
    )?.disabled,
  ).toBe(false)
  await change("edits.0.expression.kind", "literal_slot")
  const restored = onChange.mock.lastCall?.[0]
  expect(restored.edits[0]).toEqual({ ...guard, expression: slot })
  expect(restored.edits[1]).toEqual({ ...assignment, mode: "+" })
  expect(restored.edits[2]).toEqual(initial.edits[2])
})

test("baseline предоставляет каталог handles даже если текущий AST больше не содержит слотов", async () => {
  const baseline = fixture()
  const logic = fixture()
  const guard = logic.edits[0]
  const assignment = logic.edits[1]
  if (guard?.kind !== "guard" || assignment?.kind !== "assignment") {
    throw new Error("Нет исходных правок")
  }
  guard.expression = symbol
  assignment.operands = [symbol]
  const onChange = await render(logic)
  await act(() =>
    root?.render(
      <SourceLogicEditor
        baseline={baseline}
        logic={logic}
        onChange={onChange}
        projection={projection}
      />,
    ),
  )
  await change("edits.0.expression.kind", "literal_slot")
  expect(onChange.mock.lastCall?.[0].edits[0].expression).toEqual(slot)
  expect(baseline).toEqual(fixture())
})

test.each([
  "hash",
  "target",
])("каталог handles сбрасывается при смене %s и игнорирует старый baseline", async (changeScope) => {
  const baseline = fixture()
  const initial = fixture()
  const onChange = await render(initial)
  const next = fixture()
  const guard = next.edits[0]
  const assignment = next.edits[1]
  if (guard?.kind !== "guard" || assignment?.kind !== "assignment") {
    throw new Error("Нет исходных правок")
  }
  guard.expression = symbol
  assignment.operands = [symbol]
  if (changeScope === "hash") {
    next.source_hash = "b".repeat(64)
  } else {
    next.edits = next.edits.map((edit) => ({
      ...edit,
      target: { ...edit.target, block_id: "different" },
    }))
  }
  await act(() =>
    root?.render(
      <SourceLogicEditor
        baseline={baseline}
        logic={next}
        onChange={onChange}
        projection={projection}
      />,
    ),
  )
  expect(
    Array.from(select("edits.0.expression.kind").options).find(
      (option) => option.value === "literal_slot",
    )?.disabled,
  ).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})
