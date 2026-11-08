// @vitest-environment jsdom
import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ReactFlowFrame } from "../src/features/flows/react-flow/frame"
import { StepStoreProvider } from "../src/features/flows/react-flow/stores/step-store-provider"
import type { NativeSourceEditorPort } from "../src/features/flows/supacrm-source/native/document-port"
import { useNativeSourceProperty } from "../src/features/flows/supacrm-source/native/property-context"
import type {
  NativeSourceProjection,
  SourceCanvasNodeData,
} from "../src/features/flows/supacrm-source/native/types"
import type { NativeSourceBinding } from "../src/lib/source-authoring-native/authorization"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const snapshots = vi.hoisted(() => [] as { bindingId: string; label: string }[])
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
vi.mock("../src/features/flows/react-flow/react-flow-wrapper", () => ({
  ReactFlowWrapper: ({
    sourceDocument,
    onSourceSelect,
  }: {
    sourceDocument?: NativeSourceProjection
    onSourceSelect: (data: SourceCanvasNodeData) => void
  }) => {
    if (!sourceDocument) {
      throw new Error("legacy_canvas_mounted")
    }
    return (
      <div data-testid="canonical-canvas">
        {sourceDocument.nodes.map((node) => {
          snapshots.push({
            bindingId: node.data.bindingId,
            label: node.data.label,
          })
          return (
            <button
              key={node.id}
              onClick={() => onSourceSelect(node.data)}
              type="button"
            >
              {node.data.label}
            </button>
          )
        })}
      </div>
    )
  },
}))
vi.mock("../src/features/flows/react-flow/frame-header", () => ({
  FrameHeader: ({ sourceActions }: { sourceActions?: ReactNode }) => {
    if (!sourceActions) {
      throw new Error("legacy_toolbar_mounted")
    }
    return <header>{sourceActions}</header>
  },
}))
vi.mock("../src/features/flows/react-flow/nodes/node-detail-sheet", () => ({
  NodeDetailSheet: () => {
    const state = useNativeSourceProperty()
    return state?.messageEditor ? (
      <button
        data-source-dirty
        onClick={() => state.messageEditor?.onDirtyChange?.(true)}
        type="button"
      >
        Изменить сообщение
      </button>
    ) : null
  },
}))
vi.mock("../src/features/flows/react-flow/button-editor-dialog", () => ({
  ButtonEditorDialog: () => null,
}))
vi.mock(
  "../src/features/flows/react-flow/stores/flow-history-store-provider",
  () => ({
    FlowHistoryStoreProvider: () => {
      throw new Error("legacy_history_mounted")
    },
  }),
)
const binding: NativeSourceBinding = {
  kind: "source",
  bindingId: "binding-A",
  workspaceId: "100",
  flowId: "200",
  registryId: "11111111-1111-4111-8111-111111111111",
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
}
function envelope(label: string): SourceAuthoringEnvelopeV1 {
  return {
    version: "supacrm.source-authoring.v1",
    source_revision: label === "Документ A" ? "a".repeat(64) : "c".repeat(64),
    source_hash: "b".repeat(64),
    draft_version: 1,
    diagnostics: [],
    publishable: false,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: label === "Документ A" ? "a".repeat(64) : "c".repeat(64),
      nodes: [
        {
          sourceId: "note",
          scenarioId: "scenario",
          kind: "note",
          label,
          content: {},
          bindings: [],
          ports: [],
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      symbols: [],
    },
  }
}
function port(value: SourceAuthoringEnvelopeV1): NativeSourceEditorPort {
  const unused = () => Promise.reject(new Error("unexpected_operation"))
  return {
    load: vi.fn(async () => value),
    save: unused,
    compileLogic: unused,
    validate: vi.fn(async () => value),
    publish: unused,
    messageFields: unused,
    messageView: unused,
    messageSlot: unused,
    messageCompile: unused,
  }
}
let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  root = undefined
  container?.remove()
  snapshots.length = 0
})
async function render(
  sourceBinding: NativeSourceBinding,
  sourcePort: NativeSourceEditorPort,
) {
  if (!root) {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root?.render(
      <StepStoreProvider initialState={{ activeFlowId: sourceBinding.flowId }}>
        <ReactFlowFrame
          {...({
            flow: {
              id: sourceBinding.flowId,
              workspaceId: sourceBinding.workspaceId,
              name: "Source flow",
            },
            sourceBinding,
            sourcePort,
          } as unknown as Parameters<typeof ReactFlowFrame>[0])}
        />
      </StepStoreProvider>,
    ),
  )
}
function action(name: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-source-action="${name}"]`,
  )
  if (!button) {
    throw new Error("Нет native action")
  }
  return button
}
test("новая binding во время pending загружает свой документ и не применяет прежний late ACK", async () => {
  const first = envelope("Документ A"),
    second = envelope("Документ B")
  const firstPort = port(first),
    secondPort = port(second)
  let resolve: ((value: SourceAuthoringEnvelopeV1) => void) | undefined
  firstPort.validate = () =>
    new Promise((value) => {
      resolve = value
    })
  await render(binding, firstPort)
  expect(container.textContent).toContain("Документ A")
  await act(() => action("validate").click())
  expect(action("validate").disabled).toBe(true)
  const replacement: NativeSourceBinding = {
    ...binding,
    bindingId: "binding-B",
    workspaceId: "300",
    flowId: "400",
    registryId: "22222222-2222-4222-8222-222222222222",
  }
  await render(replacement, secondPort)
  expect(secondPort.load).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("Документ B")
  expect(container.textContent).not.toContain("Документ A")
  expect(
    snapshots.some(
      (snapshot) =>
        snapshot.bindingId === "binding-B" && snapshot.label === "Документ A",
    ),
  ).toBe(false)
  if (!resolve) {
    throw new Error("Нет pending validation")
  }
  await act(async () => resolve?.(first))
  expect(container.textContent).toContain("Документ B")
  expect(container.textContent).not.toContain("Документ A")
  expect(action("validate").disabled).toBe(false)
})

test("клонированная binding с теми же capabilities сохраняет dirty без повторной загрузки", async () => {
  const value = envelope("Документ A")
  const node = value.projection.nodes[0]
  if (!node) {
    throw new Error("Нет synthetic node")
  }
  node.kind = "send_message"
  const sourcePort = port(value)
  sourcePort.messageFields = vi.fn<NativeSourceEditorPort["messageFields"]>(
    async () => ({
      schema_version: "source-authoring-surface/1",
      source_revision: value.source_revision,
      source_hash: value.source_hash ?? "",
      draft_version: 1,
      fields: [
        {
          field_id: "field",
          target: {
            scenario_id: "scenario",
            block_id: "note",
            path: "params.markup",
            start: 0,
            end: 0,
            sequence: 0,
          },
          editable: true,
          code: "ordinary",
          handler_id: "source-presentation/1",
          policy_revision: "p1",
          descriptor_version: "d1",
          schema_ref: "source.message.plain-text/1",
        },
      ],
      unsupported_field_ids: [],
      production: false,
      publishable: false,
    }),
  )
  await render(binding, sourcePort)
  const nodeButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Документ A",
  )
  if (!nodeButton) {
    throw new Error("Нет source node")
  }
  await act(() => nodeButton.click())
  const dirty = container.querySelector<HTMLButtonElement>(
    "[data-source-dirty]",
  )
  if (!dirty) {
    throw new Error("Нет property dirty callback")
  }
  await act(() => dirty.click())
  expect(action("validate").disabled).toBe(true)
  expect(container.textContent).toContain("Сообщение не сохранено")
  await render(
    { ...binding, capabilities: [...binding.capabilities].reverse() },
    sourcePort,
  )
  expect(sourcePort.load).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("Сообщение не сохранено")
  expect(action("validate").disabled).toBe(true)
})
