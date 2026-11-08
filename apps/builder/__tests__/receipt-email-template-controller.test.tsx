import type { receiptEmailTemplateCandidateSchema } from "@chatbotx.io/business"
import {
  applyReceiptEmailTemplate,
  createSupacrmEmailNode,
  detachReceiptEmailTemplate,
  type FlowNode,
  getSupacrmForm,
  type SendMessageNodeSchema,
  sendMessageNodeSchema,
} from "@chatbotx.io/flow-config"
import type { ReactFlowProps, ReactFlowState } from "@xyflow/react"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { z } from "zod"
import type { FlowVersionResource } from "@/features/flow-versions/schema/resource"
import { serializeFlowContent } from "@/features/flows/flow-version-content"
import { selectSelectedNode } from "@/features/flows/react-flow/nodes/selected-node-equality"
import { ReactFlowWrapper } from "@/features/flows/react-flow/react-flow-wrapper"
import {
  FlowHistoryStoreProvider,
  useFlowHistoryStoreApi,
} from "@/features/flows/react-flow/stores/flow-history-store-provider"
import { useFlowHistory } from "@/features/flows/react-flow/stores/use-flow-history"
import { SupacrmFormEditor } from "@/features/flows/supacrm-form/form-editor"
import { ReceiptEmailTemplateDraftProvider } from "@/features/flows/supacrm-form/template-draft-context"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const h = vi.hoisted(() => ({
  save: vi.fn(),
  change: vi.fn(),
  candidates: vi.fn(),
  usages: vi.fn(),
}))
let canvas: ReactFlowProps<FlowNode> | undefined
const rf = {
  getNodes: () => canvas?.nodes ?? [],
  getEdges: () => canvas?.edges ?? [],
  getNode: (id: string) => canvas?.nodes?.find((node) => node.id === id),
  getIntersectingNodes: () => [],
  addNodes: vi.fn(),
  updateNodeData: vi.fn(),
  updateEdge: vi.fn(),
  deleteElements: vi.fn(),
  fitView: vi.fn(),
  screenToFlowPosition: (point: { x: number; y: number }) => point,
}
vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  useReactFlow: () => rf,
  Panel: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))
vi.mock("next-safe-action/hooks", () => ({
  useOptimisticAction: () => ({ execute: h.save, executeAsync: h.save }),
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
    return (
      <>
        {props.children}
        <InspectorHarness nodes={props.nodes ?? []} />
      </>
    )
  },
}))
vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    flowsAPI: {
      privateChangeReceiptEmailTemplate: h.change,
      privateReceiptEmailTemplateCandidates: h.candidates,
      privateReceiptEmailTemplateUsages: h.usages,
    },
  },
}))

function InspectorHarness({ nodes }: { nodes: FlowNode[] }) {
  const selected = selectSelectedNode({
    nodes,
  } as unknown as ReactFlowState) as SendMessageNodeSchema | null
  const { undo, redo } = useFlowHistory()
  const history = useFlowHistoryStoreApi()
  return (
    <>
      <button onClick={undo} type="button">
        undo
      </button>
      <button onClick={redo} type="button">
        redo
      </button>
      <button
        onClick={() => {
          history
            .getState()
            .takeSnapshot(
              JSON.parse(serializeFlowContent(rf.getNodes(), rf.getEdges()))
                .nodes,
              [],
            )
          undo()
        }}
        type="button"
      >
        restore-persistent-snapshot
      </button>
      {selected && getSupacrmForm(selected.data.details) && (
        <div data-selected-email={selected.id} role="dialog">
          <SupacrmFormEditor
            nodeDetails={selected.data.details}
            nodeId={selected.id}
          />
        </div>
      )}
    </>
  )
}
const candidate: z.infer<typeof receiptEmailTemplateCandidateSchema> = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "21",
  nodeId: "30",
  label: "Общая почта",
  flowName: "Общие формы",
  publishedAt: "2026-11-06T00:00:00.000Z",
  isLatest: true,
  versionNumber: 2,
}
const source = {
  kind: candidate.kind,
  flowId: candidate.flowId,
  flowVersionId: candidate.flowVersionId,
  nodeId: candidate.nodeId,
}
beforeEach(() => {
  h.save.mockResolvedValue({ data: { ok: true } })
  h.candidates.mockResolvedValue({ data: [candidate] })
  h.usages.mockResolvedValue({ data: [] })
  h.change.mockImplementation((input) => {
    expect(input.expectedNode).not.toHaveProperty("selected")
    expect(input.expectedNode.data).not.toHaveProperty("forceToolbarVisible")
    const persisted = sendMessageNodeSchema.parse(input.expectedNode)
    const updated =
      input.action === "detach"
        ? detachReceiptEmailTemplate(persisted)
        : applyReceiptEmailTemplate(persisted, {
            source,
            snapshot: getSupacrmForm(createSupacrmEmailNode({}).data.details),
            overrides: input.overrides ?? {},
          })
    const serverNode = sendMessageNodeSchema.parse(updated)
    expect(serverNode).not.toHaveProperty("selected")
    return Promise.resolve({ status: "ready", node: serverNode, changes: [] })
  })
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
  })
})

test.each([
  "assign",
  "remove",
] as const)("actual controller section %s history respects absent metadata and retains the same inspector", async (operation) => {
  const email = createSupacrmEmailNode({
    nodeProps: { id: "101" },
    dataProps: { isStartNode: true },
  })
  const live = {
    ...email,
    selected: true,
    data: { ...email.data, forceToolbarVisible: true },
  }
  const version = {
    id: "201",
    flowId: "100",
    workspaceId: "1",
    nodes: [live],
    edges: [],
  } as unknown as FlowVersionResource
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const ignore = () => undefined
  const button = (text: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === text,
    )
    if (!found) {
      throw new Error(`Missing ${text}`)
    }
    return found
  }
  try {
    await act(() =>
      root.render(
        <FlowHistoryStoreProvider>
          <ReceiptEmailTemplateDraftProvider>
            <ReactFlowWrapper
              flowVersion={version}
              onAutosaveCancelChange={ignore}
              onAutosaveFlushChange={ignore}
              onDraftDirtiedChange={ignore}
              onMarkSavedChange={ignore}
              setOpenNodeDetailSheet={ignore}
            />
          </ReceiptEmailTemplateDraftProvider>
        </FlowHistoryStoreProvider>,
      ),
    )
    const panel = container.querySelector('[role="dialog"]')
    const current = () => canvas?.nodes?.find((node) => node.id === "101")
    const assertOpen = () => {
      expect(current()?.selected).toBe(true)
      expect(current()?.data).toHaveProperty("forceToolbarVisible", true)
      expect(container.querySelector('[role="dialog"]')).toBe(panel)
    }
    expect(panel).not.toBeNull()
    expect(current()?.data).not.toHaveProperty("editorMetadata")
    const sectionTitle = container.querySelector<HTMLInputElement>(
      'input[aria-label="sectionName"]',
    )
    if (!sectionTitle) {
      throw new Error("Missing section title")
    }
    await act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(sectionTitle, "Общий раздел")
      sectionTitle.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(() => button("createSection").click())
    expect(current()?.data.editorMetadata?.section?.title).toBe("Общий раздел")
    assertOpen()
    if (operation === "remove") {
      const remove = container.querySelector<HTMLButtonElement>(
        'button[aria-label="removeSection"]',
      )
      if (!remove) {
        throw new Error("Missing section removal")
      }
      await act(() => remove.click())
      expect(current()?.data).not.toHaveProperty("editorMetadata")
      assertOpen()
      await act(() => button("undo").click())
      expect(current()?.data.editorMetadata?.section?.title).toBe(
        "Общий раздел",
      )
      assertOpen()
      await act(() => button("redo").click())
      expect(current()?.data).not.toHaveProperty("editorMetadata")
      assertOpen()
    } else {
      await act(() => button("undo").click())
      expect(current()?.data).not.toHaveProperty("editorMetadata")
      assertOpen()
      await act(() => button("redo").click())
      expect(current()?.data.editorMetadata?.section?.title).toBe(
        "Общий раздел",
      )
      assertOpen()
    }
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  canvas = undefined
})

test.each([
  "adopt",
  "detach",
] as const)("real controller/context %s keeps live Email selection and the same open inspector through undo/redo", async (operation) => {
  const email = createSupacrmEmailNode({
    nodeProps: { id: "101" },
    dataProps: { isStartNode: true },
  })
  const initial =
    operation === "detach"
      ? applyReceiptEmailTemplate(email, {
          source: { ...source, flowVersionId: "20" },
          snapshot: getSupacrmForm(email.data.details),
          overrides: { prompt: "Локальный вопрос" },
        })
      : email
  const live = {
    ...initial,
    selected: true,
    dragging: false,
    width: 410,
    height: 205,
    data: { ...initial.data, forceToolbarVisible: true },
  }
  const otherNode = createSupacrmEmailNode({ nodeProps: { id: "102" } })
  const other = {
    ...otherNode,
    selected: false,
    data: { ...otherNode.data, forceToolbarVisible: true },
  }
  const version = {
    id: "201",
    flowId: "100",
    workspaceId: "1",
    nodes: [live, other],
    edges: [],
  } as unknown as FlowVersionResource
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const ignore = () => undefined
  const flush = { current: null as (() => void) | null }
  const registerFlush = (next: (() => void) | null) => {
    flush.current = next
  }
  const button = (text: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === text,
    )
    if (!found) {
      throw new Error(`Missing ${text}`)
    }
    return found
  }
  try {
    await act(() =>
      root.render(
        <FlowHistoryStoreProvider>
          <ReceiptEmailTemplateDraftProvider>
            <ReactFlowWrapper
              flowVersion={version}
              onAutosaveCancelChange={ignore}
              onAutosaveFlushChange={registerFlush}
              onDraftDirtiedChange={ignore}
              onMarkSavedChange={ignore}
              setOpenNodeDetailSheet={ignore}
            />
          </ReceiptEmailTemplateDraftProvider>
        </FlowHistoryStoreProvider>,
      ),
    )
    const panel = container.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    const select = container.querySelector("select")
    if (!select) {
      throw new Error("Missing source select")
    }
    if (operation === "adopt") {
      await act(() => {
        select.value = "10:21:30"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await act(() => button("supacrmTemplate.preview").click())
    }
    const untouched = canvas?.nodes?.find((node) => node.id === "102")
    await act(() => button(`supacrmTemplate.${operation}`).click())
    expect(h.change).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: operation }),
    )
    expect(canvas?.nodes?.find((node) => node.id === "101")).toMatchObject({
      selected: true,
      dragging: false,
      width: 410,
      height: 205,
      data: { forceToolbarVisible: true },
    })
    expect(canvas?.nodes?.find((node) => node.id === "102")).toBe(untouched)
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    await act(() => button("undo").click())
    expect(canvas?.nodes?.find((node) => node.id === "101")?.selected).toBe(
      true,
    )
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    await act(() => button("redo").click())
    expect(canvas?.nodes?.find((node) => node.id === "101")?.selected).toBe(
      true,
    )
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    await act(() => button("restore-persistent-snapshot").click())
    expect(canvas?.nodes?.find((node) => node.id === "101")?.selected).toBe(
      true,
    )
    expect(container.querySelector('[role="dialog"]')).toBe(panel)
    await act(() => flush.current?.())
    const saved = h.save.mock.lastCall?.[0]
    expect(saved).toBeDefined()
    for (const node of saved.nodes) {
      expect(node).not.toHaveProperty("selected")
      expect(node).not.toHaveProperty("dragging")
      expect(node).not.toHaveProperty("width")
      expect(node).not.toHaveProperty("height")
      expect(node.data).not.toHaveProperty("forceToolbarVisible")
    }
  } finally {
    await act(() => root.unmount())
    container.remove()
  }
})
