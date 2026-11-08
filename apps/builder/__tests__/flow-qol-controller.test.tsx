import {
  buttonStepDefaultFn,
  type FlowNode,
  sendMessageNodeDefaultFn,
  sendTextStepDefaultFn,
} from "@chatbotx.io/flow-config"
import type { FinalConnectionState, ReactFlowProps } from "@xyflow/react"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { FlowVersionResource } from "@/features/flow-versions/schema/resource"
import { ReactFlowWrapper } from "@/features/flows/react-flow/react-flow-wrapper"
import { FlowHistoryStoreProvider } from "@/features/flows/react-flow/stores/flow-history-store-provider"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let canvas: ReactFlowProps<FlowNode> | undefined
const hooks = vi.hoisted(() => ({
  save: vi.fn(),
  intersections: vi.fn(),
  addNodes: vi.fn(),
  fitView: vi.fn(),
}))
const rf = {
  getNodes: () => canvas?.nodes ?? [],
  getEdges: () => canvas?.edges ?? [],
  getIntersectingNodes: hooks.intersections,
  addNodes: hooks.addNodes,
  updateNodeData: vi.fn(),
  updateEdge: vi.fn(),
  deleteElements: vi.fn(),
  screenToFlowPosition: (position: { x: number; y: number }) => position,
  fitView: hooks.fitView,
}
vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  useReactFlow: () => rf,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("next-safe-action/hooks", () => ({
  useOptimisticAction: () => ({
    execute: hooks.save,
    executeAsync: hooks.save,
  }),
}))
vi.mock("@/features/flows/actions/update-draft-flow-version-action", () => ({
  updateDraftFlowVersionAction: vi.fn(),
}))
vi.mock(
  "@/features/flows/supacrm-source/native/native-source-canvas-view",
  () => ({ NativeSourceCanvasView: () => null }),
)
vi.mock("@/features/flows/react-flow/qol/presentation", () => ({
  FlowQolPresentationContext: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  QolNodeViewer: () => null,
  QolButtonEdge: () => null,
  CollapsedSections: () => null,
}))
vi.mock("@/features/flows/react-flow/native-flow-canvas", () => ({
  NativeFlowCanvas: (props: ReactFlowProps<FlowNode>) => {
    canvas = props
    return null
  },
}))

const makeNodes = () => {
  const source = sendMessageNodeDefaultFn({
    nodeProps: { id: "101" },
    dataProps: { name: "Source", isStartNode: true },
  })
  source.data.details.steps = [
    sendTextStepDefaultFn({
      text: "Source",
      buttons: [{ ...buttonStepDefaultFn({ label: "Go" }), id: "button" }],
    }),
  ]
  const hidden: FlowNode = sendMessageNodeDefaultFn({
    nodeProps: { id: "102", position: { x: 600, y: 200 } },
    dataProps: { name: "Hidden" },
  })
  hidden.selected = true
  hidden.data.editorMetadata = { section: { id: "s", title: "Hidden section" } }
  const visible = sendMessageNodeDefaultFn({
    nodeProps: { id: "103" },
    dataProps: { name: "Visible" },
  })
  return [source, hidden, visible]
}

const preferences = new Map<string, string>()
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => preferences.set(key, value),
  })
})
afterEach(() => {
  preferences.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  canvas = undefined
})

test("controller ignores a hidden-member drop without changing routes or edges and preserves visible-node drops", async () => {
  localStorage.setItem("flow-qol:1:10", '["s"]')
  const nodes = makeNodes()
  const version = {
    id: "10",
    workspaceId: "1",
    nodes,
    edges: [],
  } as unknown as FlowVersionResource
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const ignore = () => undefined
  try {
    await act(() =>
      root.render(
        <FlowHistoryStoreProvider>
          <ReactFlowWrapper
            flowVersion={version}
            onAutosaveCancelChange={ignore}
            onAutosaveFlushChange={ignore}
            onDraftDirtiedChange={ignore}
            onMarkSavedChange={ignore}
            setOpenNodeDetailSheet={ignore}
          />
        </FlowHistoryStoreProvider>,
      ),
    )
    expect(canvas?.nodes?.find((node) => node.id === "102")?.selected).toBe(
      false,
    )
    const beforeNodes = JSON.stringify(canvas?.nodes)
    const beforeEdges = JSON.stringify(canvas?.edges)
    hooks.intersections.mockReturnValue([nodes[1]])
    const drop = () =>
      canvas?.onConnectEnd?.(
        new MouseEvent("mouseup", { clientX: 610, clientY: 210 }),
        {
          fromNode: nodes[0],
          fromHandle: { id: "button", type: "source" },
          toNode: null,
          toHandle: null,
        } as unknown as FinalConnectionState,
      )
    await act(drop)
    expect(JSON.stringify(canvas?.nodes)).toBe(beforeNodes)
    expect(JSON.stringify(canvas?.edges)).toBe(beforeEdges)
    expect(hooks.addNodes).not.toHaveBeenCalled()
    await act(() =>
      canvas?.onConnect?.({
        source: "101",
        target: "102",
        sourceHandle: "button",
        targetHandle: "102",
      }),
    )
    expect(JSON.stringify(canvas?.edges)).toBe(beforeEdges)
    hooks.intersections.mockReturnValue([nodes[2], nodes[1]])
    await act(drop)
    expect(canvas?.edges).toEqual([
      expect.objectContaining({
        source: "101",
        sourceHandle: "button",
        target: "103",
      }),
    ])
    const source = canvas?.nodes?.[0]
    const details = source?.data.details
    const step = details && "steps" in details ? details.steps?.[0] : undefined
    expect(
      step && "buttons" in step ? step.buttons[0]?.beforeStep : null,
    ).toMatchObject({ nodeId: "103" })
    hooks.intersections.mockReturnValue([])
    await act(drop)
    expect(hooks.addNodes).toHaveBeenCalledTimes(1)
    const created = hooks.addNodes.mock.calls[0]?.[0]?.[0] as FlowNode
    expect(canvas?.edges).toEqual([
      expect.objectContaining({
        source: "101",
        sourceHandle: "button",
        target: created.id,
      }),
    ])
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
