// @vitest-environment jsdom
import { sourceKinds } from "@chatbotx.io/flow-config"
import type { NodeProps } from "@xyflow/react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { nativeSourceNodeId } from "../src/features/flows/supacrm-source/native/projection-adapter"
import { SourceNodeCard } from "../src/features/flows/supacrm-source/native/source-node-card"
import type { SourceCanvasNode } from "../src/features/flows/supacrm-source/native/types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mock = vi.hoisted(() => ({
  locale: "ru",
  handles: [] as {
    id: string
    type: string
    isConnectable?: boolean
    isConnectableStart?: boolean
    isConnectableEnd?: boolean
  }[],
}))
vi.mock("next-intl", async () => {
  const ru = (await import("../messages/ru.json")).default
  const en = (await import("../messages/en.json")).default
  return {
    useLocale: () => mock.locale,
    useTranslations: (namespace?: string) => (key: string) => {
      if (!namespace?.startsWith("supacrmNativeSource")) {
        return key
      }
      const catalog = mock.locale.toLowerCase().startsWith("ru") ? ru : en
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
vi.mock("@/components/base-handle", () => ({
  BaseHandle: (props: {
    id: string
    type: string
    isConnectable?: boolean
    isConnectableStart?: boolean
    isConnectableEnd?: boolean
  }) => {
    mock.handles.push(props)
    return <span data-handle-id={props.id} data-handle-type={props.type} />
  },
}))
const fixture = (): NodeProps<SourceCanvasNode> => ({
  id: "node-ui",
  type: "sourceProjection",
  selected: false,
  dragging: false,
  draggable: true,
  selectable: true,
  deletable: false,
  isConnectable: false,
  zIndex: 0,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  data: {
    documentMode: "source",
    bindingId: "binding",
    registryId: "registry",
    scenarioId: "scenario",
    sourceId: "block",
    sourceKind: "send_message",
    label: "Приветствие",
    scopeKey: "scope",
    ports: [
      {
        projectionPortId: "p0",
        handleId: "exact-handle-null",
        label: "∅",
        source: {
          scenario_id: "scenario",
          block_id: "block",
          source_path: "ports.0",
          sequence: 0,
          name: null,
          target_block_id: null,
        },
      },
      {
        projectionPortId: "p1",
        handleId: "exact-handle-default",
        label: "Иначе",
        source: {
          scenario_id: "scenario",
          block_id: "block",
          source_path: "ports.1",
          sequence: 1,
          name: "default",
          target_block_id: "target",
        },
      },
    ],
  },
})
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  mock.handles = []
  mock.locale = "ru"
})
async function render(props = fixture()) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(() => root?.render(<SourceNodeCard {...props} />))
  return container
}

test("native Card содержит только безопасную подпись и все точные readonly BaseHandles", async () => {
  const view = await render()
  expect(view.querySelector('[data-slot="card"]')).not.toBeNull()
  expect(view.querySelector('[data-slot="card-header"]')).not.toBeNull()
  expect(view.querySelector('[data-slot="card-content"]')).not.toBeNull()
  expect(view.textContent).toContain("Приветствие")
  expect(view.textContent).toContain("Иначе")
  expect(mock.handles.map((handle) => [handle.id, handle.type])).toEqual([
    ["node-ui", "target"],
    ["exact-handle-null", "source"],
    ["exact-handle-default", "source"],
  ])
  for (const handle of mock.handles) {
    expect(handle.isConnectable).toBe(false)
    expect(handle.isConnectableStart).toBe(false)
    expect(handle.isConnectableEnd).toBe(false)
  }
  expect(view.querySelector("input,textarea,button,a")).toBeNull()
})

test("native карточка не использует legacy toolbar/details и применяет английский fallback проекта", async () => {
  mock.locale = "de"
  const props = fixture()
  props.data.label = "send_message"
  props.selected = true
  const view = await render(props)
  expect(view.textContent).toContain("Message")
  expect(view.textContent).toContain("Connections are read-only")
  expect(view.textContent).not.toContain("Node not found")
  expect(view.querySelector("[data-legacy-toolbar],.tiptap")).toBeNull()
})

test("английский UI и пустые подписи сохраняют исходные IDs портов", async () => {
  mock.locale = "en"
  const props = fixture()
  props.data.label = ""
  const port = props.data.ports[0]
  if (!port) {
    throw new Error("Нет порта")
  }
  props.data.ports[0] = { ...port, label: "" }
  const view = await render(props)
  expect(view.textContent).toContain("Message")
  expect(view.textContent).toContain("Connections are read-only")
  expect(mock.handles[1]?.id).toBe("exact-handle-null")
})

test("все32sourcekinds используют native карточку без legacy registry fallback", async () => {
  await render()
  for (const sourceKind of sourceKinds) {
    const props = fixture()
    props.data.sourceKind = sourceKind
    props.data.label = sourceKind
    await act(() => root?.render(<SourceNodeCard {...props} />))
    expect(container?.querySelector('[data-slot="card"]')).not.toBeNull()
    expect(container?.textContent).not.toContain("Node not found")
  }
})

test("UI identity безопасна для штатного ReactFlow data-id selector с Unicode и кавычками", () => {
  const id = nativeSourceNodeId(
    {
      bindingId: 'binding"quoted',
      registryId: "registry",
      workspaceId: "workspace",
      flowId: "flow",
    },
    "сценарий",
    "block[0]",
  )
  const element = document.createElement("div")
  element.className = "react-flow__node"
  element.dataset.id = id
  document.body.append(element)
  try {
    expect(document.querySelector(`.react-flow__node[data-id="${id}"]`)).toBe(
      element,
    )
  } finally {
    element.remove()
  }
})
