// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ReactFlowWrapper } from "../src/features/flows/react-flow/react-flow-wrapper"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const boundary = vi.hoisted(() => ({ save: vi.fn(), hook: vi.fn() }))
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
vi.mock(
  "../src/features/flows/actions/update-draft-flow-version-action",
  () => ({ updateDraftFlowVersionAction: boundary.save }),
)
vi.mock("next-safe-action/hooks", () => ({
  useOptimisticAction: () => {
    boundary.hook()
    return { execute: boundary.save, executeAsync: boundary.save }
  },
}))
vi.mock("../src/features/flows/react-flow/nodes/viewer", () => ({
  NodeViewer: () => null,
}))
vi.mock(
  "../src/features/flows/react-flow/panel-buttons/add-node-button",
  () => ({ default: () => null }),
)
vi.mock(
  "../src/features/flows/react-flow/stores/flow-history-store-provider",
  () => ({
    useFlowHistoryStoreApi: () => {
      throw new Error("legacy_history_mounted")
    },
  }),
)
vi.mock("@xyflow/react", async () => {
  const React = await import("react")
  return {
    MarkerType: { ArrowClosed: "arrowclosed" },
    useReactFlow: () => ({
      getNodes: () => [],
      getEdges: () => [],
      fitView: () => undefined,
      zoomIn: () => undefined,
      zoomOut: () => undefined,
    }),
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = React.useState(initial)
      return [nodes, setNodes, () => undefined]
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial)
      return [edges, setEdges, () => undefined]
    },
    applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
    ReactFlow: (props: {
      nodes: { id: string; data: { label: string } }[]
      children: React.ReactNode
      onNodeClick?: (e: unknown, node: unknown) => void
      onNodesChange?: (changes: unknown[]) => void
    }) => (
      <div aria-label="Штатный canvas" role="application">
        {props.nodes.map((node) => (
          <button
            key={node.id}
            onClick={() => props.onNodeClick?.({}, node)}
            type="button"
          >
            {node.data.label}
          </button>
        ))}
        <button
          onClick={() =>
            props.onNodesChange?.([
              {
                type: "position",
                id: "ui-message",
                dragging: true,
                position: { x: 10, y: 20 },
              },
            ])
          }
          type="button"
        >
          Событие перемещения
        </button>
        {props.children}
      </div>
    ),
    ControlButton: (props: {
      children: React.ReactNode
      onClick?: () => void
    }) => (
      <button onClick={props.onClick} type="button">
        {props.children}
      </button>
    ),
    Background: () => null,
    Controls: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    Panel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  }
})
const node = {
  id: "ui-message",
  type: "sourceProjection",
  position: { x: 0, y: 0 },
  data: {
    documentMode: "source",
    bindingId: "binding",
    registryId: "a",
    scenarioId: "scenario",
    sourceId: "source-message",
    sourceKind: "send_message",
    label: "Исходное сообщение",
    scopeKey: "pin:1",
    ports: [],
  },
}
const document = {
  nodes: [node],
  edges: [],
  scopeKey: "pin:1",
  unresolvedEdges: [],
}
let root: Root | undefined
let container: HTMLDivElement
const render = async (locked = false) => {
  container = globalThis.document.createElement("div")
  globalThis.document.body.append(container)
  root = createRoot(container)
  const Source = () => {
    const [selected, setSelected] = useState("")
    return (
      <>
        <ReactFlowWrapper
          {...({
            sourceDocument: document,
            sourceLocked: locked,
            selectedNodeId: selected,
            onSourceSelect: (data: typeof node.data) =>
              setSelected(data.sourceId),
          } as unknown as Parameters<typeof ReactFlowWrapper>[0])}
        />
        <output>{selected}</output>
      </>
    )
  }
  await act(() => root?.render(<Source />))
}
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

test("source document renders without reading legacy FlowVersion or mounting legacy persistence/history", async () => {
  await render()
  expect(container.querySelector('[role="application"]')).not.toBeNull()
  expect(container.textContent).toContain("Исходное сообщение")
  expect(boundary.hook).not.toHaveBeenCalled()
  expect(boundary.save).not.toHaveBeenCalled()
})

test("source selection selects canonical identity without legacy save", async () => {
  await render()
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Исходное сообщение",
  )
  if (!button) {
    throw new Error("Карточка отсутствует")
  }
  await act(() => button.click())
  expect(container.querySelector("output")?.textContent).toBe("source-message")
  expect(boundary.save).not.toHaveBeenCalled()
})

test("source lock rejects selection and stray drag events without starting legacy autosave", async () => {
  await render(true)
  await act(() => {
    for (const button of Array.from(container.querySelectorAll("button"))) {
      button.click()
    }
  })
  expect(container.querySelector("output")?.textContent).toBe("")
  expect(boundary.hook).not.toHaveBeenCalled()
  expect(boundary.save).not.toHaveBeenCalled()
})
