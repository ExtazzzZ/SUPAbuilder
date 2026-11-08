// @vitest-environment jsdom
import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ReactFlowFrame } from "../src/features/flows/react-flow/frame"
import { StepStoreProvider } from "../src/features/flows/react-flow/stores/step-store-provider"
import type { NativeSourceEditorPort } from "../src/features/flows/supacrm-source/native/document-port"
import type { NativeSourceBinding } from "../src/lib/source-authoring-native/authorization"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const boundary = vi.hoisted(() => ({
  nodes: [] as { id: string; selected?: boolean; data: { label: string } }[],
  legacySave: vi.fn(),
  legacyPublish: vi.fn(),
}))
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
vi.mock("../src/features/flows/react-flow/native-flow-canvas", () => ({
  NativeFlowCanvas: (props: {
    nodes: typeof boundary.nodes
    onNodeClick?: (e: unknown, node: unknown) => void
    onPaneClick?: () => void
    isMutating: boolean
  }) => {
    boundary.nodes = props.nodes
    return (
      <div data-locked={props.isMutating} role="application">
        {props.nodes.map((n) => (
          <button
            key={n.id}
            onClick={() => props.onNodeClick?.({}, n)}
            type="button"
          >
            {n.data.label}
          </button>
        ))}
        <button data-pane onClick={props.onPaneClick} type="button">
          Пустое место карты
        </button>
      </div>
    )
  },
}))
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>()
  return {
    ...original,
    useStore: (
      selector: (state: { nodes: typeof boundary.nodes }) => unknown,
    ) => selector({ nodes: boundary.nodes }),
    useReactFlow: () => {
      throw new Error("legacy_hook_in_source_panel")
    },
  }
})
vi.mock("../src/features/flows/react-flow/frame-header", () => ({
  FrameHeader: ({ sourceActions }: { sourceActions?: ReactNode }) => (
    <header>{sourceActions}</header>
  ),
}))
vi.mock("../src/features/flows/react-flow/button-editor-dialog", () => ({
  ButtonEditorDialog: () => null,
}))
vi.mock("../src/features/flows/react-flow/nodes/viewer", () => ({
  NodeViewer: () => null,
}))
vi.mock("../src/features/flows/react-flow/nodes/editor", () => ({
  NodeEditor: () => {
    throw new Error("legacy_editor_in_source")
  },
}))
vi.mock("../src/features/flows/react-flow/nodes/node-name-editor", () => ({
  NodeNameEditor: () => {
    throw new Error("legacy_name_in_source")
  },
}))
vi.mock("../src/features/custom-fields/provider/custom-field-hook", () => ({
  useCustomFields: () => {
    throw new Error("legacy_fields_in_source")
  },
}))
vi.mock("../src/hooks/routing", () => ({ useWorkspaceId: () => "100" }))
vi.mock(
  "../src/features/flows/react-flow/panel-buttons/add-node-button",
  () => ({ default: () => null }),
)
vi.mock(
  "../src/features/flows/react-flow/stores/flow-history-store-provider",
  () => ({
    FlowHistoryStoreProvider: () => {
      throw new Error("legacy_history_in_source")
    },
    useFlowHistoryStoreApi: () => {
      throw new Error("legacy_history_in_source")
    },
  }),
)
vi.mock(
  "../src/features/flows/actions/update-draft-flow-version-action",
  () => ({ updateDraftFlowVersionAction: boundary.legacySave }),
)
vi.mock("../src/features/flows/actions/publish-flow-action", () => ({
  publishFlowAction: boundary.legacyPublish,
}))
const binding: NativeSourceBinding = {
  kind: "source",
  bindingId: "binding",
  registryId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "100",
  flowId: "200",
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
}
const target = {
  scenario_id: "scenario",
  block_id: "message",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
function envelope(
  pin = "a".repeat(64),
  raw = "b".repeat(64),
  draft = 1,
): SourceAuthoringEnvelopeV1 {
  return {
    version: "supacrm.source-authoring.v1",
    source_revision: pin,
    source_hash: raw,
    draft_version: draft,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: pin,
      nodes: [
        {
          sourceId: "message",
          scenarioId: "scenario",
          kind: "send_message",
          label: "Исходное сообщение",
          ports: [],
          bindings: [],
          content: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      symbols: [],
    },
    diagnostics: [],
    publishable: false,
  }
}
const field = {
  field_id: "message:markup",
  target,
  editable: true,
  code: "ordinary",
  handler_id: "source-presentation/1",
  schema_ref: "source.message.plain-text/1",
  policy_revision: "policy",
  descriptor_version: "1",
}
function fixture() {
  let current = envelope(),
    text = "A",
    issued = "A"
  const sourceHash = () => {
    const hash = current.source_hash
    if (!hash) {
      throw new Error("source_hash_missing_in_fixture")
    }
    return hash
  }
  const view = () => ({
    ...field,
    schema_version: "message-field-view/1" as const,
    source_revision: current.source_revision,
    source_hash: sourceHash(),
    draft_version: current.draft_version,
    slot: {
      kind: "literal_slot" as const,
      slot_id: "ordinary-slot",
      declared_type: "str" as const,
    },
    text,
  })
  const safeView = () => {
    const v = view()
    const { editable: _editable, code: _code, ...safe } = v
    return safe
  }
  const port = {
    load: vi.fn<NativeSourceEditorPort["load"]>(() => Promise.resolve(current)),
    save: vi.fn<NativeSourceEditorPort["save"]>(),
    compileLogic: vi.fn<NativeSourceEditorPort["compileLogic"]>(),
    validate: vi.fn<NativeSourceEditorPort["validate"]>(() =>
      Promise.resolve({ ...current, publishable: true }),
    ),
    publish: vi.fn<NativeSourceEditorPort["publish"]>(() =>
      Promise.resolve({
        ...current,
        publishable: true,
        published_revision: current.source_revision,
      }),
    ),
    messageFields: vi.fn<NativeSourceEditorPort["messageFields"]>(() =>
      Promise.resolve({
        schema_version: "source-authoring-surface/1",
        source_revision: current.source_revision,
        source_hash: sourceHash(),
        draft_version: current.draft_version,
        fields: [field],
        unsupported_field_ids: [],
        production: false,
        publishable: false,
      }),
    ),
    messageView: vi.fn<NativeSourceEditorPort["messageView"]>(() =>
      Promise.resolve(safeView()),
    ),
    messageSlot: vi.fn<NativeSourceEditorPort["messageSlot"]>((write) => {
      issued = write.text
      return Promise.resolve({ ...safeView(), text: issued })
    }),
    messageCompile: vi.fn<NativeSourceEditorPort["messageCompile"]>(() => {
      current = envelope("c".repeat(64), "d".repeat(64), 2)
      text = issued
      return Promise.resolve(current)
    }),
  } satisfies NativeSourceEditorPort
  return {
    port,
    get current() {
      return current
    },
    get text() {
      return text
    },
    commitThenLoseResponse: () => {
      port.messageCompile.mockImplementation(() => {
        current = envelope("c".repeat(64), "d".repeat(64), 2)
        text = issued
        return Promise.reject(new Error("connection_lost"))
      })
    },
  }
}
async function runInAct(operation: () => void) {
  await act(async () => {
    operation()
    await Promise.resolve()
  })
}
let root: Root | undefined, container: HTMLDivElement
async function render(port?: NativeSourceEditorPort) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await runInAct(() =>
    root?.render(
      <StepStoreProvider initialState={{ activeFlowId: "200" }}>
        <ReactFlowFrame
          {...({
            flow: { id: "200", workspaceId: "100", name: "Source flow" },
            sourceBinding: binding,
            sourcePort: port,
          } as unknown as Parameters<typeof ReactFlowFrame>[0])}
        />
      </StepStoreProvider>,
    ),
  )
}
afterEach(async () => {
  await runInAct(() => root?.unmount())
  container?.remove()
  root = undefined
  boundary.nodes = []
  vi.clearAllMocks()
})
function button(text: string) {
  const e = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )
  if (!e) {
    throw new Error(`button_missing:${text}`)
  }
  return e
}
function action(name: string) {
  const e = document.querySelector<HTMLButtonElement>(
    `[data-source-action="${name}"]`,
  )
  if (!e) {
    throw new Error(`action_missing:${name}`)
  }
  return e
}
async function open() {
  await runInAct(() => button("Исходное сообщение").click())
}
async function edit(value: string) {
  const e = document.querySelector("textarea")
  if (!e) {
    throw new Error("native_plain_field_missing")
  }
  await runInAct(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(e, value)
    e.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return e
}

test("native source frame opens canonical plain field in Sheet without legacy editor/history/persistence", async () => {
  const f = fixture()
  await render(f.port)
  await open()
  expect(document.querySelector("textarea")?.value).toBe("A")
  expect(boundary.legacySave).not.toHaveBeenCalled()
  expect(boundary.legacyPublish).not.toHaveBeenCalled()
})

test("native field compile updates canonical scope then native header validates and publishes through source port", async () => {
  const f = fixture()
  await render(f.port)
  await open()
  await edit("B — literal {{ x() }} <b>")
  expect(action("validate").disabled).toBe(true)
  await runInAct(() => button("Скомпилировать сообщение").click())
  expect(f.port.messageCompile).toHaveBeenCalledTimes(1)
  expect(
    f.port.messageCompile.mock.calls[0]?.[0].template.runs[0]?.slot_id,
  ).toBe("ordinary-slot")
  expect(
    JSON.stringify(f.port.messageCompile.mock.calls[0]?.[0]),
  ).not.toContain("B —")
  await runInAct(() => action("validate").click())
  expect(action("publish").disabled).toBe(false)
  await runInAct(() => action("publish").click())
  expect(f.port.publish.mock.calls[0]?.[0].source_revision).toBe("c".repeat(64))
  expect(boundary.legacySave).not.toHaveBeenCalled()
  expect(boundary.legacyPublish).not.toHaveBeenCalled()
})

test("native unknown retains text and panel, blocks map/toolbar mutations, explicit reload recovers committed pin", async () => {
  const f = fixture()
  f.commitThenLoseResponse()
  await render(f.port)
  await open()
  await edit("D — %marker% {{ x() }} <b>")
  await runInAct(() => button("Скомпилировать сообщение").click())
  expect(action("validate").disabled).toBe(true)
  expect(action("publish").disabled).toBe(true)
  await runInAct(() => button("Пустое место карты").click())
  expect(document.querySelector("textarea")?.value).toBe(
    "D — %marker% {{ x() }} <b>",
  )
  await runInAct(() => action("reload").click())
  expect(document.querySelector("textarea")?.value).toBe(
    "D — %marker% {{ x() }} <b>",
  )
  expect(f.port.messageCompile).toHaveBeenCalledTimes(1)
  expect(f.port.load).toHaveBeenCalledTimes(2)
  expect(boundary.legacySave).not.toHaveBeenCalled()
})

test("absent native source transport stays source readonly and never falls back to legacy flow", async () => {
  await render()
  expect(action("validate").disabled).toBe(true)
  expect(action("publish").disabled).toBe(true)
  expect(document.querySelector("textarea")).toBeNull()
  expect(boundary.legacySave).not.toHaveBeenCalled()
})

test("заблокированная server validation показывает русскую причину и публичный код, сохраняя запрет публикации", async () => {
  const f = fixture()
  f.port.validate.mockResolvedValue({
    ...f.current,
    publishable: false,
    diagnostics: [{ code: "source_validation_blocked", block_id: "message" }],
  })
  await render(f.port)
  await runInAct(() => action("validate").click())
  const diagnostics = Array.from(document.querySelectorAll('[role="alert"]'))
    .map((element) => element.textContent ?? "")
    .join(" ")
  expect(diagnostics).toContain("Публикация заблокирована")
  expect(diagnostics).toContain("source_validation_blocked")
  expect(action("publish").disabled).toBe(true)
  expect(f.port.publish).not.toHaveBeenCalled()
  expect(boundary.legacyPublish).not.toHaveBeenCalled()
})
