import { ReactFlowProvider, useReactFlow } from "@xyflow/react"
import { NextIntlClientProvider } from "next-intl"
import { act, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"
import { NativeFlowCanvas } from "@/features/flows/react-flow/native-flow-canvas"
import {
  CollapsedSections,
  FlowQolPresentationContext,
  QolButtonEdge,
  QolNodeViewer,
} from "@/features/flows/react-flow/qol/presentation"
import { buildCollapsedSectionView } from "@/features/flows/react-flow/qol/section-view"
import messages from "../messages/en.json"

vi.mock("@/features/flows/react-flow/nodes/viewer", () => ({
  NodeViewer: ({ data }: { data: { name: string } }) => (
    <div style={{ width: 288, height: 100 }}>{data.name}</div>
  ),
}))
vi.mock("@/features/flows/react-flow/panel-buttons/add-node-button", () => ({
  default: () => null,
}))
const nodeTypes = { sendMessage: QolNodeViewer }
const edgeTypes = { buttonedge: QolButtonEdge }
const nodes = [
  {
    id: "101",
    type: "sendMessage",
    position: { x: 100, y: 200 },
    data: {
      name: "Каталог",
      editorMetadata: { section: { id: "s", title: "Каталог" } },
    },
  },
  {
    id: "102",
    type: "sendMessage",
    position: { x: 700, y: 200 },
    data: { name: "Выход" },
  },
]
const edges = [
  {
    id: "original-edge",
    type: "buttonedge",
    source: "101",
    sourceHandle: "original-handle",
    target: "102",
  },
]

test("native canvas collapse and expand retain canonical React Flow nodes and original edge handles", async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let readGraph: (() => unknown) | undefined
  function Harness() {
    const [collapsed, setCollapsed] = useState(["s"])
    const rf = useReactFlow()
    const view = buildCollapsedSectionView(nodes, edges, collapsed)
    useEffect(() => {
      readGraph = () => ({ nodes: rf.getNodes(), edges: rf.getEdges() })
    }, [rf])
    return (
      <FlowQolPresentationContext value={view}>
        <NativeFlowCanvas
          controls={<span />}
          edges={edges}
          edgeTypes={edgeTypes}
          isMutating={false}
          nodes={nodes}
          nodeTypes={nodeTypes}
        >
          <CollapsedSections onExpand={() => setCollapsed([])} view={view} />
        </NativeFlowCanvas>
      </FlowQolPresentationContext>
    )
  }
  try {
    await act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ReactFlowProvider>
            <Harness />
          </ReactFlowProvider>
        </NextIntlClientProvider>,
      ),
    )
    const graph = readGraph?.() as { nodes: typeof nodes; edges: typeof edges }
    expect(graph.nodes.map((node) => node.id)).toEqual(["101", "102"])
    expect(graph.edges[0]?.sourceHandle).toBe("original-handle")
    expect(
      container.querySelectorAll('[data-testid="flow-qol-collapsed-section"]'),
    ).toHaveLength(1)
    expect(
      (container.querySelector(".flow-qol-hidden") as HTMLElement)?.style
        .visibility,
    ).toBe("hidden")
    const hiddenWrapper = container.querySelector(
      '.react-flow__node[data-id="101"]',
    ) as HTMLElement
    expect(hiddenWrapper.getAttribute("tabindex")).toBe("-1")
    expect(hiddenWrapper.hasAttribute("inert")).toBe(true)
    expect(hiddenWrapper.getAttribute("aria-hidden")).toBe("true")
    expect(hiddenWrapper.style.pointerEvents).toBe("none")
    const expand = container.querySelector(
      '[aria-label="Expand section Каталог"]',
    ) as HTMLButtonElement
    expect(expand.disabled).toBe(false)
    await act(() => expand.click())
    expect(hiddenWrapper.hasAttribute("inert")).toBe(false)
    expect(hiddenWrapper.getAttribute("tabindex")).toBe("0")
    expect(hiddenWrapper.hasAttribute("aria-hidden")).toBe(false)
    expect(container.querySelectorAll(".flow-qol-hidden")).toHaveLength(0)
    expect(
      (readGraph?.() as { nodes: typeof nodes }).nodes.map((node) => node.id),
    ).toEqual(["101", "102"])
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
