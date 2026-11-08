// @vitest-environment jsdom
import { type SourceProjection, sourceKinds } from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { SupacrmSourceGraph } from "../src/features/flows/supacrm-source/source-graph"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mock = vi.hoisted(() => ({ props: undefined as unknown }))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    mock.props = props
    return <div />
  },
  Background: () => null,
  Controls: () => null,
  Handle: ({ id, type }: { id: string; type: string }) => (
    <span data-handle-id={id} data-handle-type={type} />
  ),
  Position: { Left: "left", Right: "right" },
}))
const fixture = (): SourceProjection => ({
  version: "supacrm.source-projection.v1",
  sourceRevision: "synthetic",
  nodes: sourceKinds.map((kind, index) => ({
    sourceId: `source-${index}`,
    kind,
    label: `Блок ${index}`,
    scenarioId: "scenario",
    ports: [
      { id: `${index}-yes`, label: "Да" },
      { id: `${index}-no`, label: "Нет" },
    ],
    bindings: [],
    content: {
      richText: "Текст",
      editMode: "edit",
      media: [{ id: "m", kind: "image", assetRef: "asset:synthetic" }],
    },
    position: { x: index * 400, y: (index % 2) * 150 },
  })),
  edges: sourceKinds.slice(1).map((_, index) => ({
    id: `edge-${index}`,
    sourceId: `source-${index}`,
    portId: `${index}-yes`,
    targetId: `source-${index + 1}`,
  })),
  symbols: [],
})
function required<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error("Нет элемента проверки")
  }
  return value
}
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
})
async function render(projection = fixture(), disabled = false) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const onChange = vi.fn(),
    onSelectSource = vi.fn()
  await act(() =>
    root?.render(
      <SupacrmSourceGraph
        disabled={disabled}
        onChange={onChange}
        onSelectSource={onSelectSource}
        projection={projection}
        selectedSourceId="source-3"
      />,
    ),
  )
  return { onChange, onSelectSource, projection }
}

test("передаёт все 32 вида, точные source IDs, порты и рёбра без legacy node enum", async () => {
  const { projection } = await render()
  const props = mock.props as {
    nodes: {
      id: string
      data: { source: SourceProjection["nodes"][number] }
      selected: boolean
    }[]
    edges: {
      id: string
      source: string
      sourceHandle: string
      target: string
      targetHandle: string
    }[]
    onlyRenderVisibleElements: boolean
    nodesConnectable: boolean
    edgesReconnectable: boolean
    nodeTypes: Record<string, unknown>
  }
  expect(props.nodes).toHaveLength(32)
  expect(props.nodes.map((node) => node.id)).toEqual(
    projection.nodes.map((node) => node.sourceId),
  )
  expect(props.nodes.map((node) => node.data.source.kind)).toEqual(sourceKinds)
  expect(props.nodes[3]?.selected).toBe(true)
  expect(props.edges).toEqual(
    projection.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      sourceHandle: edge.portId,
      target: edge.targetId,
      targetHandle: edge.targetId,
    })),
  )
  expect(props.onlyRenderVisibleElements).toBe(true)
  expect(props.nodesConnectable).toBe(false)
  expect(props.edgesReconnectable).toBe(false)
  expect(Object.keys(props.nodeTypes)).toEqual(["sourceProjection"])
})

test("drag меняет только position в прежнем порядке с сохранением metadata", async () => {
  const { projection, onChange } = await render()
  const props = mock.props as { onNodesChange: (changes: unknown[]) => void }
  await act(() =>
    props.onNodesChange([
      {
        type: "position",
        id: "source-2",
        position: { x: 18, y: 29 },
        dragging: true,
      },
      { type: "remove", id: "source-1" },
      { type: "position", id: "missing", position: { x: 2, y: 3 } },
    ]),
  )
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange.mock.calls[0]?.[0]).toEqual({
    ...projection,
    nodes: projection.nodes.map((node) =>
      node.sourceId === "source-2"
        ? { ...node, position: { x: 18, y: 29 } }
        : node,
    ),
  })
})

test("выбор узла не изменяет проекцию и disabled canvas не двигает блоки", async () => {
  const { onChange, onSelectSource } = await render(fixture(), true)
  const props = mock.props as {
    onNodeClick: (event: unknown, node: { id: string }) => void
    onNodesChange: (changes: unknown[]) => void
    nodesDraggable: boolean
  }
  await act(() => props.onNodeClick({}, { id: "source-12" }))
  expect(onSelectSource).toHaveBeenCalledWith("source-12")
  expect(props.nodesDraggable).toBe(false)
  await act(() =>
    props.onNodesChange([
      { type: "position", id: "source-2", position: { x: 18, y: 29 } },
    ]),
  )
  expect(onChange).not.toHaveBeenCalled()
})

test("custom source node отображает все output Handles с точными port IDs", async () => {
  const { projection } = await render()
  const props = mock.props as {
    nodeTypes: {
      sourceProjection: (props: {
        data: { source: SourceProjection["nodes"][number] }
        selected: boolean
      }) => React.ReactNode
    }
  }
  const Node = props.nodeTypes.sourceProjection
  await act(() =>
    root?.render(
      <Node data={{ source: required(projection.nodes[2]) }} selected />,
    ),
  )
  const view = required(container)
  expect(view.textContent).toContain("send_message")
  expect(
    Array.from(view.querySelectorAll('[data-handle-type="source"]')).map(
      (handle) => handle.getAttribute("data-handle-id"),
    ),
  ).toEqual(["2-yes", "2-no"])
  expect(
    view
      .querySelector('[data-handle-type="target"]')
      ?.getAttribute("data-handle-id"),
  ).toBe("source-2")
})

test("безопасно игнорирует измерения, одинаковые координаты и нечисловой drag", async () => {
  const { projection, onChange } = await render()
  const props = mock.props as { onNodesChange: (changes: unknown[]) => void }
  await act(() =>
    props.onNodesChange([
      {
        type: "dimensions",
        id: "source-0",
        dimensions: { width: 300, height: 200 },
      },
      {
        type: "position",
        id: "source-0",
        position: required(projection.nodes[0]).position,
      },
      { type: "position", id: "source-1", position: { x: Number.NaN, y: 0 } },
      { type: "position", id: "source-2" },
    ]),
  )
  expect(onChange).not.toHaveBeenCalled()
})

test("пустые подписи используют source ID и port ID без изменения проекции", async () => {
  const { projection } = await render()
  const props = mock.props as {
    nodeTypes: {
      sourceProjection: (props: {
        data: { source: SourceProjection["nodes"][number] }
        selected: boolean
      }) => React.ReactNode
    }
  }
  const Node = props.nodeTypes.sourceProjection
  const source = {
    ...required(projection.nodes[0]),
    label: "",
    ports: [{ id: "fallback-port", label: "" }],
  }
  await act(() => root?.render(<Node data={{ source }} selected={false} />))
  expect(required(container).textContent).toContain(source.sourceId)
  expect(required(container).textContent).toContain("fallback-port")
})

test("измерения остаются локальными для canvas и не теряются после controlled drag", async () => {
  const { onChange } = await render()
  const props = mock.props as { onNodesChange: (changes: unknown[]) => void }
  await act(() =>
    props.onNodesChange([
      {
        type: "dimensions",
        id: "source-0",
        dimensions: { width: 240, height: 160 },
      },
    ]),
  )
  const updated = mock.props as {
    nodes: { id: string; measured?: { width: number; height: number } }[]
  }
  expect(
    updated.nodes.find((node) => node.id === "source-0")?.measured,
  ).toEqual({ width: 240, height: 160 })
  expect(onChange).not.toHaveBeenCalled()
})
