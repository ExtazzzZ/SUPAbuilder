// @vitest-environment jsdom
import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { NodeDetailSheet } from "../src/features/flows/react-flow/nodes/node-detail-sheet"
import { selectedNodeEqualityFn } from "../src/features/flows/react-flow/nodes/selected-node-equality"
import { messageAuthoringLabels } from "../src/features/flows/supacrm-source/message-authoring/labels"
import { MessageAuthoringRejected } from "../src/features/flows/supacrm-source/message-authoring/port"
import { NativeMessageFieldForm } from "../src/features/flows/supacrm-source/native/native-message-field-form"
import { nativeSourceScopeKey } from "../src/features/flows/supacrm-source/native/projection-adapter"
import {
  NativeSourcePropertyProvider,
  type NativeSourcePropertyState,
} from "../src/features/flows/supacrm-source/native/property-context"
import type {
  NativeSourceBinding,
  SourceCanvasNode,
} from "../src/features/flows/supacrm-source/native/types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mocks = vi.hoisted(() => ({
  selected: null as unknown,
  legacyEditor: vi.fn(),
  legacyName: vi.fn(),
  customFields: vi.fn(() => ({ isFetched: true })),
  reactFlow: vi.fn(() => {
    throw new Error("legacy_react_flow_hook")
  }),
}))
vi.mock("@xyflow/react", () => ({
  useStore: (selector: (state: { nodes: unknown[] }) => unknown) =>
    selector({ nodes: mocks.selected ? [mocks.selected] : [] }),
  useReactFlow: mocks.reactFlow,
}))
vi.mock("../src/features/flows/react-flow/nodes/editor", () => ({
  NodeEditor: mocks.legacyEditor,
}))
vi.mock("../src/features/flows/react-flow/nodes/node-name-editor", () => ({
  NodeNameEditor: mocks.legacyName,
}))
vi.mock("../src/features/custom-fields/provider/custom-field-hook", () => ({
  useCustomFields: mocks.customFields,
}))
vi.mock("../src/hooks/routing", () => ({ useWorkspaceId: () => "workspace" }))
vi.mock("next-intl", async () => {
  const ru = (await import("../messages/ru.json")).default
  const en = (await import("../messages/en.json")).default
  return {
    useLocale: () => "ru",
    useTranslations: (namespace?: string) => (key: string) => {
      if (!namespace?.startsWith("supacrmNativeSource")) {
        return key
      }
      const catalog = "ru".toLowerCase().startsWith("ru") ? ru : en
      const value = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (parent, part) =>
            typeof parent === "object" && parent !== null
              ? (parent as Record<string, unknown>)[part]
              : undefined,
          catalog,
        )
      if (typeof value !== "string") {
        throw new Error(`Недостающий ключ перевода: ${namespace}.${key}`)
      }
      return value
    },
  }
})
const binding: NativeSourceBinding = {
  bindingId: "binding",
  registryId: "registry",
  workspaceId: "workspace",
  flowId: "flow",
}
const span = {
  scenario_id: "scenario",
  block_id: "source",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
function fixture() {
  const envelope: SourceAuthoringEnvelopeV1 = {
    version: "supacrm.source-authoring.v1",
    source_revision: "ir1",
    source_hash: "hash1",
    draft_version: 1,
    diagnostics: [],
    publishable: false,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: "ir1",
      symbols: [],
      edges: [],
      nodes: [
        {
          sourceId: "source",
          scenarioId: "scenario",
          kind: "send_message",
          label: "Карточка источника",
          ports: [],
          bindings: [],
          content: {},
          position: { x: 0, y: 0 },
        },
      ],
    },
  }
  const node: SourceCanvasNode = {
    id: "source-canvas-id",
    type: "sourceProjection",
    position: { x: 0, y: 0 },
    selected: true,
    data: {
      documentMode: "source",
      bindingId: binding.bindingId,
      registryId: binding.registryId,
      scenarioId: "scenario",
      sourceId: "source",
      sourceKind: "send_message",
      label: "Карточка источника",
      scopeKey: nativeSourceScopeKey(binding, envelope),
      ports: [],
    },
  }
  const field = {
    field_id: "field",
    target: span,
    editable: true,
    code: "ok",
    handler_id: "source-presentation/1",
    policy_revision: "policy1",
    descriptor_version: "descriptor1",
    schema_ref: "source.message.plain-text/1",
  }
  const view = {
    schema_version: "message-field-view/1",
    field_id: "field",
    target: span,
    source_revision: "ir1",
    source_hash: "hash1",
    draft_version: 1,
    handler_id: field.handler_id,
    policy_revision: field.policy_revision,
    descriptor_version: field.descriptor_version,
    schema_ref: field.schema_ref,
    slot: { kind: "literal_slot", slot_id: "slot1", declared_type: "str" },
    text: "A",
  }
  const port = {
    readField: vi.fn().mockResolvedValue({ field, view }),
    writeLiteral: vi
      .fn()
      .mockImplementation(async (write) => ({ ...view, text: write.text })),
    compileField: vi.fn().mockResolvedValue({
      sourceRevision: "ir2",
      sourceHash: "hash2",
      draftVersion: 2,
    }),
  }
  const state: NativeSourcePropertyState = {
    binding,
    envelope,
    status: "ready",
    messageEditor: {
      port,
      scope: {
        fieldId: "field",
        sourceKind: "send_message",
        target: span,
        fullPin: {
          sourceRevision: "ir1",
          sourceHash: "hash1",
          draftVersion: 1,
        },
      },
      onCompiled: vi.fn(),
      onReloadRequested: vi.fn().mockResolvedValue(undefined),
    },
  }
  return { node, state, port, envelope }
}
let root: Root | undefined
let container: HTMLDivElement
const labels = messageAuthoringLabels("ru")
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})
async function mount(component: ReactNode) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(component))
}
function input() {
  const element = document.querySelector<HTMLTextAreaElement>(
    'textarea[data-slot="textarea"]',
  )
  if (!element) {
    throw new Error("Нет native поля")
  }
  return element
}
function save() {
  const element = Array.from(document.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === labels.save,
  )
  if (!element) {
    throw new Error("Нет native Save")
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
function sheet(state?: NativeSourcePropertyState) {
  const element = <NodeDetailSheet onOpenChange={vi.fn()} open />
  return state ? (
    <NativeSourcePropertyProvider value={state}>
      {element}
    </NativeSourcePropertyProvider>
  ) : (
    element
  )
}

test("source выбирает real native Sheet и E1 до legacy editors/custom fields/hooks", async () => {
  const { node, state, port } = fixture()
  mocks.selected = node
  await mount(sheet(state))
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="sheet-title"]')?.textContent).toBe(
    "Карточка источника",
  )
  expect(input().value).toBe("A")
  expect(save().getAttribute("data-slot")).toBe("button")
  expect(port.readField).toHaveBeenCalledTimes(1)
  expect(mocks.legacyEditor).not.toHaveBeenCalled()
  expect(mocks.legacyName).not.toHaveBeenCalled()
  expect(mocks.customFields).not.toHaveBeenCalled()
  expect(mocks.reactFlow).not.toHaveBeenCalled()
})

test.each([
  "absent",
  "binding",
  "scope",
  "unsupported",
  "editor_pin",
])("source %s остаётся readonly без legacy fallback и раскрытия текста", async (reason) => {
  const { node, state, port } = fixture()
  mocks.selected = node
  if (reason === "binding") {
    state.binding = { ...binding, bindingId: "other" }
  }
  if (reason === "scope") {
    node.data.scopeKey = "stale"
  }
  if (reason === "unsupported") {
    node.data.sourceKind = "switch"
  }
  if (reason === "editor_pin" && state.messageEditor) {
    state.messageEditor.scope.fullPin.sourceHash = "different"
  }
  await mount(sheet(reason === "absent" ? undefined : state))
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  expect(document.querySelector("textarea")).toBeNull()
  expect(port.readField).not.toHaveBeenCalled()
  expect(mocks.legacyEditor).not.toHaveBeenCalled()
  expect(mocks.customFields).not.toHaveBeenCalled()
})

test("новый full pin меняет source equality и не переиспользует старый draft", async () => {
  const { node, state, envelope } = fixture()
  mocks.selected = node
  await mount(sheet(state))
  await type("D")
  const nextEnvelope = {
    ...envelope,
    source_revision: "ir2",
    source_hash: "hash2",
    draft_version: 2,
    projection: { ...envelope.projection, sourceRevision: "ir2" },
  }
  const next = {
    ...node,
    data: {
      ...node.data,
      scopeKey: nativeSourceScopeKey(binding, nextEnvelope),
    },
  }
  expect(selectedNodeEqualityFn(node, next)).toBe(false)
  const nextState = {
    ...state,
    envelope: nextEnvelope,
    messageEditor: undefined,
  }
  mocks.selected = next
  await act(() => root?.render(sheet(nextState)))
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).not.toContain("D")
})

test("native форма сохраняет D при unknown, блокирует повтор и оставляет literal без HTML", async () => {
  const { node, state, port } = fixture()
  mocks.selected = node
  port.compileField.mockRejectedValueOnce(new Error("unconfirmed"))
  await mount(sheet(state))
  const draft = "D % {{literal}} <b>ordinary</b>"
  await type(draft)
  await act(() => save().click())
  expect(input().value).toBe(draft)
  expect(document.querySelector("b")).toBeNull()
  expect(save().disabled).toBe(true)
  expect(input().disabled).toBe(false)
  await act(() => save().click())
  expect(port.writeLiteral).toHaveBeenCalledTimes(1)
  expect(port.compileField).toHaveBeenCalledTimes(1)
})

test("native form передаёт dirty и защищает pending/double click, known422 сохраняет D", async () => {
  const onDirtyChange = vi.fn()
  const onCommit = vi
    .fn()
    .mockRejectedValue(new MessageAuthoringRejected("validation_rejected"))
  await mount(
    <NativeMessageFieldForm
      editable
      fieldId="field"
      label="Сообщение"
      labels={labels}
      onCommit={onCommit}
      onDirtyChange={onDirtyChange}
      pending={false}
      text="A"
    />,
  )
  await type("D")
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  await act(() => {
    save().click()
    save().click()
  })
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("D")
  expect(input().value).toBe("D")
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    labels.saveError,
  )
  await act(() =>
    root?.render(
      <NativeMessageFieldForm
        editable
        fieldId="field"
        label="Сообщение"
        labels={labels}
        onCommit={onCommit}
        pending
        text="A"
      />,
    ),
  )
  expect(save().disabled).toBe(true)
})

test("неполный documentMode=source остаётся в readonly Sheet без legacy fallback", async () => {
  mocks.selected = {
    id: "bad-source",
    selected: true,
    data: { documentMode: "source" },
  }
  await mount(sheet())
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  expect(document.querySelector("textarea")).toBeNull()
  expect(mocks.reactFlow).not.toHaveBeenCalled()
  expect(mocks.legacyEditor).not.toHaveBeenCalled()
})

test.each([
  "loading",
  "readonly",
  "error",
] as const)("status %s не читает поле и не раскрывает fallback content", async (status) => {
  const { node, state, port } = fixture()
  mocks.selected = node
  state.status = status
  const source = state.envelope?.projection.nodes[0]
  if (source) {
    source.content.richText = "FORBIDDEN_FALLBACK_TEXT"
  }
  await mount(sheet(state))
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).not.toContain("FORBIDDEN_FALLBACK_TEXT")
  expect(port.readField).not.toHaveBeenCalled()
})

test("native readonly форма вообще не содержит переданный текст", async () => {
  await mount(
    <NativeMessageFieldForm
      editable={false}
      fieldId="field"
      label="Сообщение"
      labels={labels}
      onCommit={vi.fn()}
      pending={false}
      readOnlyReason="Нет разрешения"
      text="HIDDEN_LITERAL"
    />,
  )
  expect(document.body.innerHTML).not.toContain("HIDDEN_LITERAL")
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.body.textContent).toContain("Нет разрешения")
})

test("source equality учитывает label и scope и не реагирует на неавторитетные details", () => {
  const { node } = fixture()
  expect(
    selectedNodeEqualityFn(node, { ...node, data: { ...node.data } }),
  ).toBe(true)
  expect(
    selectedNodeEqualityFn(node, {
      ...node,
      data: { ...node.data, label: "Новое имя" },
    }),
  ).toBe(false)
  expect(selectedNodeEqualityFn(node, null)).toBe(false)
})

test("source context без selection во время загрузки не монтирует legacy hooks", async () => {
  const { state } = fixture()
  state.status = "loading"
  mocks.selected = null
  await mount(sheet(state))
  expect(mocks.reactFlow).not.toHaveBeenCalled()
  expect(mocks.customFields).not.toHaveBeenCalled()
  expect(mocks.legacyName).not.toHaveBeenCalled()
  expect(mocks.legacyEditor).not.toHaveBeenCalled()
})

test("source context с чужим legacy-looking selection остаётся readonly без fallback", async () => {
  const { state, port } = fixture()
  mocks.selected = {
    id: "foreign",
    type: "sendMessage",
    selected: true,
    position: { x: 0, y: 0 },
    data: { name: "Чужая карточка", details: { steps: [] } },
  }
  await mount(sheet(state))
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
  expect(document.querySelector("textarea")).toBeNull()
  expect(mocks.reactFlow).not.toHaveBeenCalled()
  expect(mocks.customFields).not.toHaveBeenCalled()
  expect(mocks.legacyName).not.toHaveBeenCalled()
  expect(mocks.legacyEditor).not.toHaveBeenCalled()
  expect(port.readField).not.toHaveBeenCalled()
})
