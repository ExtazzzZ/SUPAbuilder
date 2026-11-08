import {
  applyRouteUpdatesInNodes,
  assignFlowSection,
  type FlowNode,
  type FlowRouteUpdate,
  type FlowSection,
  getFlowNodeSection,
  nodeTypeSchema,
  removeFlowSection,
  sendMessageNodeDefaultFn,
} from "@chatbotx.io/flow-config"
import { useDebouncedCallback } from "@chatbotx.io/ui/hooks/use-debounced-callback"
import {
  type Connection,
  type Edge,
  type FinalConnectionState,
  MarkerType,
  type Node,
  type NodeChange,
  Panel,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useOptimisticAction } from "next-safe-action/hooks"
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import { client } from "@/lib/orpc/orpc"
import { updateDraftFlowVersionAction } from "../actions/update-draft-flow-version-action"
import type { UpdateDraftFlowVersionSchema } from "../schema/action"
import {
  createReceiptEmailTemplateAcknowledgement,
  createReceiptEmailTemplateDraftMutation,
} from "../supacrm-form/template-draft"
import { useReceiptEmailTemplateDraft } from "../supacrm-form/template-draft-context"
import {
  NativeSourceCanvasView,
  type NativeSourceCanvasViewProps,
} from "../supacrm-source/native/native-source-canvas-view"
import {
  createDeleteNode,
  type DeleteSaveResult,
} from "./delete-node-orchestrator"
import {
  createDuplicateNode,
  type DuplicateSaveResult,
} from "./duplicate-node-orchestrator"
import { FlowMutationProvider } from "./flow-mutation-context"
import { mergeLiveNodeUi } from "./live-node-ui"
import { NativeFlowCanvas } from "./native-flow-canvas"
import { FlowNavigationPanel } from "./qol/navigation-panel"
import {
  CollapsedSections,
  FlowQolPresentationContext,
  QolButtonEdge,
  QolNodeViewer,
} from "./qol/presentation"
import { buildCollapsedSectionView } from "./qol/section-view"
import { duplicateFlowNode } from "./toolbar/duplicate-node-data"
import "./react-flow-wrapper.css"
import { createId } from "@chatbotx.io/utils"
import type { FlowVersionResource } from "@/features/flow-versions/schema/resource"
import { serializeFlowContent } from "../flow-version-content"
import {
  getRoutableHandleId,
  replaceSourceHandleEdge,
  toRouteRemovals,
} from "./edge-routing"
import { findNodeAtPoint } from "./node-hit-test"
import { hasMeaningfulNodeChange } from "./react-flow-node-change"
import { useFlowHistoryStoreApi } from "./stores/flow-history-store-provider"
import { useFlowHistory } from "./stores/use-flow-history"

function getClientPosition(event: MouseEvent | TouchEvent) {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0]
    return touch ? { x: touch.clientX, y: touch.clientY } : null
  }

  return { x: event.clientX, y: event.clientY }
}

const viewerNodeTypes = {
  [nodeTypeSchema.enum.sendMessage]: QolNodeViewer,
  [nodeTypeSchema.enum.sendMail]: QolNodeViewer,
  [nodeTypeSchema.enum.landingPage]: QolNodeViewer,
  [nodeTypeSchema.enum.performAction]: QolNodeViewer,
  [nodeTypeSchema.enum.addNotes]: QolNodeViewer,
  [nodeTypeSchema.enum.wait]: QolNodeViewer,
  [nodeTypeSchema.enum.followUp]: QolNodeViewer,
  [nodeTypeSchema.enum.startFlow]: QolNodeViewer,
  [nodeTypeSchema.enum.splitTraffic]: QolNodeViewer,
  [nodeTypeSchema.enum.condition]: QolNodeViewer,
}

const edgeTypes = {
  buttonedge: QolButtonEdge,
}

type ReactFlowFrameProps = {
  flowVersion: FlowVersionResource
  setOpenNodeDetailSheet: (open: boolean) => void
  onAutosaveFlushChange: (flushAutosave: (() => void) | null) => void
  onAutosaveCancelChange: (cancelAutosave: (() => void) | null) => void
  onDraftDirtiedChange: (dirtied: boolean) => void
  onMarkSavedChange: (
    markSaved: ((nodes: Node[], edges: Edge[]) => void) | null,
  ) => void
}

export function ReactFlowWrapper(
  props: ReactFlowFrameProps | NativeSourceCanvasViewProps,
) {
  if ("sourceDocument" in props) {
    return <NativeSourceCanvasView {...props} />
  }
  return <LegacyReactFlowController {...props} />
}

function LegacyReactFlowController({
  flowVersion,
  onAutosaveFlushChange,
  onAutosaveCancelChange,
  onDraftDirtiedChange,
  onMarkSavedChange,
  setOpenNodeDetailSheet,
}: ReactFlowFrameProps) {
  const reactFlow = useReactFlow()
  const {
    addNodes,
    getNodes,
    getIntersectingNodes,
    updateNodeData,
    updateEdge,
    getEdges,
    deleteElements,
    screenToFlowPosition,
  } = reactFlow

  const [nodes, setNodes, onNodesChange] = useNodesState(
    flowVersion.nodes as unknown as FlowNode[],
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    (flowVersion.edges as unknown as Edge[]).map((edge) => ({
      ...edge,
      type: "buttonedge",
      markerEnd: {
        type: MarkerType.ArrowClosed,
      },
    })),
  )
  const [collapsedSections, setCollapsedSections] = useState<string[]>([])
  const [viewLoaded, setViewLoaded] = useState(false)
  const storageKey = `flow-qol:${flowVersion.workspaceId}:${flowVersion.id}`
  useEffect(() => {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "[]",
      )
      if (Array.isArray(parsed)) {
        const collapsed = parsed.filter(
          (id): id is string => typeof id === "string",
        )
        setCollapsedSections(collapsed)
        setNodes((current) => {
          const isHiddenSelected = (node: FlowNode) =>
            node.selected &&
            collapsed.includes(getFlowNodeSection(node)?.id ?? "")
          if (!current.some(isHiddenSelected)) {
            return current
          }
          return current.map((node) =>
            isHiddenSelected(node) ? { ...node, selected: false } : node,
          )
        })
      }
    } catch {
      // Unavailable browser storage does not prevent editing the draft.
    }
    setViewLoaded(true)
  }, [storageKey, setNodes])
  useEffect(() => {
    if (!viewLoaded) {
      return
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(collapsedSections))
    } catch {
      /* Browser preference only. */
    }
  }, [collapsedSections, storageKey, viewLoaded])
  const sectionView = useMemo(
    () => buildCollapsedSectionView(nodes, edges, collapsedSections),
    [nodes, edges, collapsedSections],
  )
  const lastSavedSerializedRef = useRef(
    serializeFlowContent(
      flowVersion.nodes as unknown as FlowNode[],
      flowVersion.edges as unknown as Edge[],
    ),
  )
  const lastPersistedSerializedRef = useRef(lastSavedSerializedRef.current)

  const { executeAsync: savingDraftAsync } = useOptimisticAction(
    updateDraftFlowVersionAction.bind(
      null,
      flowVersion.workspaceId,
      flowVersion.id,
    ),
    {
      currentState: { flowVersion },
      updateFn: (state, updatedData) => ({
        flowVersion: {
          ...state.flowVersion,
          nodes: JSON.parse(JSON.stringify(updatedData.nodes)),
          edges: JSON.parse(JSON.stringify(updatedData.edges)),
        },
      }),
    },
  )

  const pendingSavesRef = useRef(new Set<Promise<unknown>>())
  const [templateAcknowledgement] = useState(() =>
    createReceiptEmailTemplateAcknowledgement(flowVersion.nodes),
  )
  const t = useTranslations()
  const saveDraft = useCallback(
    (input: UpdateDraftFlowVersionSchema) => {
      const content = JSON.parse(
        serializeFlowContent(input.nodes, input.edges),
      ) as Pick<UpdateDraftFlowVersionSchema, "nodes" | "edges">
      const payload = {
        ...input,
        ...content,
        expectedTemplateBase: templateAcknowledgement.getBase(),
      }
      const task = savingDraftAsync(payload)
      pendingSavesRef.current.add(task)
      task.then(
        (result) => {
          if (result?.data?.ok) {
            lastPersistedSerializedRef.current = serializeFlowContent(
              payload.nodes,
              payload.edges,
            )
            templateAcknowledgement.acknowledge(payload.nodes)
          } else {
            toast.error(result?.serverError || t("supacrmTemplate.error"))
          }
          pendingSavesRef.current.delete(task)
        },
        () => pendingSavesRef.current.delete(task),
      )
      return task
    },
    [savingDraftAsync, templateAcknowledgement, t],
  )

  const handleChanges = useDebouncedCallback(
    (changedNodes: FlowNode[], changedEdges: Edge[]) => {
      saveDraft({
        nodes: changedNodes,
        edges: changedEdges as unknown as UpdateDraftFlowVersionSchema["edges"],
      }).catch(() => toast.error(t("supacrmTemplate.error")))
    },
    1500,
    4000,
  )

  const [isFlowMutating, setIsFlowMutating] = useState(false)
  const isMutatingRef = useRef(false)
  const snapshotSessionRef = useRef(false)
  // Capture deliberately reads React Flow's internal store here. The restore
  // path writes through the controlled props so undo/redo stays out of
  // onNodesChange/onEdgesChange.
  const { takeSnapshot } = useFlowHistory()
  const historyStore = useFlowHistoryStoreApi()

  // Register the local state setters as the history store's restore handlers so
  // undo/redo write through the controlled nodes/edges props. React Flow's
  // StoreUpdater syncs those props into its internal store WITHOUT firing
  // onNodesChange/onEdgesChange, so restoring never re-enters the snapshot path.
  useEffect(() => {
    const restoreNodes = (restoredNodes: Node[]) => {
      const live = new Map(getNodes().map((node) => [node.id, node]))
      setNodes(
        restoredNodes.map((node) =>
          mergeLiveNodeUi(node, live.get(node.id)),
        ) as FlowNode[],
      )
    }

    const restoreEdges = (restoredEdges: Edge[]) =>
      setEdges(
        restoredEdges.map((edge) => ({
          ...edge,
          type: "buttonedge",
          markerEnd: { type: MarkerType.ArrowClosed },
        })),
      )

    historyStore
      .getState()
      .setRestoreHandlers({ setNodes: restoreNodes, setEdges: restoreEdges })

    return () => historyStore.getState().setRestoreHandlers(null)
  }, [historyStore, setNodes, setEdges, getNodes])

  const releaseSnapshotSession = useDebouncedCallback(() => {
    snapshotSessionRef.current = false
  }, 500)

  const takeCoalescedSnapshot = useCallback(() => {
    if (!snapshotSessionRef.current) {
      takeSnapshot()
      snapshotSessionRef.current = true
    }
    releaseSnapshotSession()
  }, [takeSnapshot, releaseSnapshotSession])

  const hasMeaningfulEdgeChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) =>
      changes.some(
        (change) => change.type === "add" || change.type === "remove",
      ),
    [],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      if (hasMeaningfulNodeChange(changes)) {
        takeCoalescedSnapshot()
      }
      onNodesChange(
        changes.filter(
          (change) =>
            !(
              "id" in change &&
              sectionView.hiddenNodeIds.has(change.id) &&
              (change.type === "select" || change.type === "position")
            ),
        ),
      )
    },
    [onNodesChange, takeCoalescedSnapshot, sectionView.hiddenNodeIds],
  )

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      if (hasMeaningfulEdgeChange(changes)) {
        takeCoalescedSnapshot()
      }
      onEdgesChange(changes)
    },
    [hasMeaningfulEdgeChange, onEdgesChange, takeCoalescedSnapshot],
  )

  const handleNodeDragStart = useCallback(() => {
    takeCoalescedSnapshot()
  }, [takeCoalescedSnapshot])

  const handleNodeDragStop = useCallback(() => {
    releaseSnapshotSession()
  }, [releaseSnapshotSession])

  const duplicateNode = useMemo(
    () =>
      createDuplicateNode({
        isMutatingRef,
        setIsFlowMutating,
        cancelAutosave: () => handleChanges.cancel(),
        getNodes: () => getNodes() as unknown as FlowNode[],
        getEdges,
        cloneNode: duplicateFlowNode,
        addNodes,
        // The action input schema types `nodes` as `any[]` (FlowNode[] flows in
        // freely) and `edges` as the zod edge schema, so only `edges` needs a cast.
        // The resolved result is cast to the orchestrator's narrow `DuplicateSaveResult`.
        saveDraft: async (input) =>
          (await saveDraft({
            nodes: input.nodes,
            edges:
              input.edges as unknown as UpdateDraftFlowVersionSchema["edges"],
          })) as DuplicateSaveResult,
        onError: () => toast.error(t("messages.duplicateNodeError")),
      }),
    [getNodes, getEdges, addNodes, handleChanges, saveDraft, t],
  )

  const deleteNode = useMemo(
    () =>
      createDeleteNode({
        isMutatingRef,
        setIsFlowMutating,
        cancelAutosave: () => handleChanges.cancel(),
        deleteElements,
        getNodes: () => getNodes() as unknown as FlowNode[],
        getEdges,
        saveDraft: async (input) =>
          (await saveDraft({
            nodes: input.nodes,
            edges:
              input.edges as unknown as UpdateDraftFlowVersionSchema["edges"],
          })) as DeleteSaveResult,
        onError: () => toast.error(t("messages.deleteNodeError")),
      }),
    [getNodes, getEdges, deleteElements, handleChanges, saveDraft, t],
  )

  const duplicateNodeWithHistory = useCallback(
    async (sourceNode: FlowNode) => {
      takeSnapshot()
      await duplicateNode(sourceNode)
    },
    [duplicateNode, takeSnapshot],
  )

  const deleteNodeWithHistory = useCallback(
    async (nodeId: string) => {
      takeSnapshot()
      await deleteNode(nodeId)
    },
    [deleteNode, takeSnapshot],
  )

  const flowMutationValue = useMemo(
    () => ({
      deleteNode: deleteNodeWithHistory,
      duplicateNode: duplicateNodeWithHistory,
      isFlowMutating,
    }),
    [isFlowMutating, duplicateNodeWithHistory, deleteNodeWithHistory],
  )

  useEffect(() => {
    if (isFlowMutating || isMutatingRef.current) {
      return
    }
    const serialized = serializeFlowContent(nodes, edges as Edge[])
    if (serialized === lastSavedSerializedRef.current) {
      return
    }

    lastSavedSerializedRef.current = serialized
    onDraftDirtiedChange(true)
    handleChanges(nodes, edges)
  }, [handleChanges, nodes, edges, onDraftDirtiedChange, isFlowMutating])

  const markSaved = useCallback(
    (savedNodes: Node[], savedEdges: Edge[]) => {
      lastSavedSerializedRef.current = serializeFlowContent(
        savedNodes,
        savedEdges,
      )
      lastPersistedSerializedRef.current = lastSavedSerializedRef.current
      templateAcknowledgement.acknowledge(savedNodes)
      onDraftDirtiedChange(
        serializeFlowContent(getNodes(), getEdges()) !==
          lastPersistedSerializedRef.current,
      )
    },
    [onDraftDirtiedChange, templateAcknowledgement, getNodes, getEdges],
  )

  const { register: registerTemplateMutation, registerAcknowledgedBase } =
    useReceiptEmailTemplateDraft()
  useEffect(() => {
    registerAcknowledgedBase(templateAcknowledgement.getBase)
    return () => registerAcknowledgedBase(null)
  }, [registerAcknowledgedBase, templateAcknowledgement])
  const runTemplateMutation = useMemo(
    () =>
      createReceiptEmailTemplateDraftMutation({
        isMutatingRef,
        setMutating: setIsFlowMutating,
        cancelAutosave: () => {
          handleChanges.cancel()
          // A cancelled scheduled save must resume after a refused/preview-only operation.
          lastSavedSerializedRef.current = lastPersistedSerializedRef.current
        },
        waitForSaves: async () => {
          const results = await Promise.all([...pendingSavesRef.current])
          if (
            results.some(
              (result) =>
                !(result as { data?: { ok?: boolean } } | undefined)?.data?.ok,
            )
          ) {
            throw new Error("draftSaveFailed")
          }
        },
        getGraph: () =>
          JSON.parse(serializeFlowContent(getNodes(), getEdges())),
        mutate: (input) =>
          client.flowsAPI.privateChangeReceiptEmailTemplate({
            ...input,
            flowId: flowVersion.flowId,
            workspaceId: flowVersion.workspaceId,
          }),
        apply: (node) => {
          takeSnapshot()
          const next = (getNodes() as FlowNode[]).map((current) =>
            current.id === node.id
              ? mergeLiveNodeUi<FlowNode>(node, current)
              : current,
          )
          setNodes(next)
          markSaved(next, getEdges())
        },
      }),
    [
      handleChanges,
      getNodes,
      getEdges,
      flowVersion.flowId,
      flowVersion.workspaceId,
      takeSnapshot,
      setNodes,
      markSaved,
    ],
  )
  useEffect(() => {
    registerTemplateMutation(runTemplateMutation)
    return () => registerTemplateMutation(null)
  }, [registerTemplateMutation, runTemplateMutation])

  useEffect(() => {
    onAutosaveFlushChange(handleChanges.flush)
    onAutosaveCancelChange(handleChanges.cancel)
    onMarkSavedChange(markSaved)

    return () => {
      onAutosaveFlushChange(null)
      onAutosaveCancelChange(null)
      onMarkSavedChange(null)
    }
  }, [
    handleChanges.cancel,
    handleChanges.flush,
    markSaved,
    onAutosaveCancelChange,
    onAutosaveFlushChange,
    onMarkSavedChange,
  ])

  useEffect(
    () => () => {
      releaseSnapshotSession.cancel()
    },
    [releaseSnapshotSession],
  )

  const handleNodeClick = useCallback(
    (_event: ReactMouseEvent, node: Node) => {
      if (!sectionView.hiddenNodeIds.has(node.id)) {
        setOpenNodeDetailSheet(true)
      }
    },
    [setOpenNodeDetailSheet, sectionView.hiddenNodeIds],
  )

  const handlePaneClick = useCallback(() => {
    setOpenNodeDetailSheet(false)
  }, [setOpenNodeDetailSheet])

  const onNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: Node) => {
      updateNodeData(node.id, { forceToolbarVisible: true })
    },
    [updateNodeData],
  )

  const onNodeMouseLeave = useCallback(
    (_event: ReactMouseEvent, node: Node) => {
      updateNodeData(node.id, { forceToolbarVisible: false })
    },
    [updateNodeData],
  )

  const applyButtonRoutes = useCallback(
    (routeUpdates: readonly FlowRouteUpdate[]) => {
      setNodes((currentNodes) =>
        applyRouteUpdatesInNodes(currentNodes, routeUpdates),
      )
    },
    [setNodes],
  )

  const onConnect = useCallback(
    (params: Connection) => {
      if (
        params.source === params.target ||
        sectionView.hiddenNodeIds.has(params.source) ||
        sectionView.hiddenNodeIds.has(params.target)
      ) {
        return
      }

      takeCoalescedSnapshot()
      setEdges((currentEdges) =>
        replaceSourceHandleEdge(currentEdges, {
          ...params,
          type: "buttonedge",
        }),
      )

      const handleId = getRoutableHandleId(params.source, params.sourceHandle)
      if (handleId) {
        applyButtonRoutes([
          {
            sourceNodeId: params.source,
            handleId,
            route: { targetNodeId: params.target },
          },
        ])
      }
    },
    [
      applyButtonRoutes,
      setEdges,
      takeCoalescedSnapshot,
      sectionView.hiddenNodeIds,
    ],
  )

  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: FinalConnectionState,
    ): void => {
      const fromHandle = connectionState.fromHandle
      const fromNode = connectionState.fromNode
      if (
        !(fromHandle?.id && fromNode) ||
        sectionView.hiddenNodeIds.has(fromNode.id) ||
        fromHandle.type !== "source" ||
        connectionState.toHandle ||
        connectionState.toNode
      ) {
        return
      }

      const fromHandleId = fromHandle.id
      // connectionState.to is pane-relative; screenToFlowPosition needs raw
      // viewport client coordinates, so derive them from the event itself.
      const clientPosition = getClientPosition(event)
      const position = clientPosition
        ? screenToFlowPosition(clientPosition)
        : { x: 300, y: 300 }

      const droppedOnNode = clientPosition
        ? findNodeAtPoint(
            getIntersectingNodes,
            position,
            fromNode.id,
            sectionView.hiddenNodeIds,
          )
        : undefined

      // A collapsed member's old rectangle is neither a visible destination
      // nor an empty-pane request to create a new executable node/route.
      if (
        !droppedOnNode &&
        clientPosition &&
        sectionView.hiddenNodeIds.size > 0 &&
        findNodeAtPoint(getIntersectingNodes, position, fromNode.id)
      ) {
        return
      }

      if (droppedOnNode) {
        takeCoalescedSnapshot()
        setEdges((currentEdges) =>
          replaceSourceHandleEdge(currentEdges, {
            id: createId(),
            source: fromNode.id,
            target: droppedOnNode.id,
            sourceHandle: fromHandleId,
            targetHandle: droppedOnNode.id,
            type: "buttonedge",
          }),
        )

        const routableHandleId = getRoutableHandleId(fromNode.id, fromHandleId)
        if (routableHandleId) {
          applyButtonRoutes([
            {
              sourceNodeId: fromNode.id,
              handleId: routableHandleId,
              route: { targetNodeId: droppedOnNode.id },
            },
          ])
        }
        return
      }

      const messageNodesLength = getNodes().filter(
        (node) => node.type === nodeTypeSchema.enum.sendMessage,
      ).length
      const newNode = sendMessageNodeDefaultFn({
        nodeProps: { position },
        dataProps: {
          name: `${t("actions.sendMessage")} #${messageNodesLength + 1}`,
        },
      })

      takeCoalescedSnapshot()
      addNodes([newNode])
      setEdges((currentEdges) =>
        replaceSourceHandleEdge(currentEdges, {
          id: createId(),
          source: fromNode.id,
          target: newNode.id,
          sourceHandle: fromHandleId,
          targetHandle: newNode.id,
          type: "buttonedge",
        }),
      )

      const handleId = getRoutableHandleId(fromNode.id, fromHandleId)
      if (handleId) {
        applyButtonRoutes([
          {
            sourceNodeId: fromNode.id,
            handleId,
            route: { targetNodeId: newNode.id },
          },
        ])
      }
    },
    [
      addNodes,
      getNodes,
      getIntersectingNodes,
      setEdges,
      applyButtonRoutes,
      screenToFlowPosition,
      takeCoalescedSnapshot,
      sectionView.hiddenNodeIds,
      t,
    ],
  )

  const onEdgeMouseEnter = useCallback(
    (_event: ReactMouseEvent, edge: Edge) => {
      const edgeId = edge.id

      // Updates edge
      updateEdge(edgeId, (oldEdge) => ({
        data: { ...oldEdge.data, isHovered: true },
      }))
    },
    [updateEdge],
  )

  const onEdgeMouseLeave = useCallback(
    (_event: ReactMouseEvent, edge: Edge) => {
      const edgeId = edge.id
      updateEdge(edgeId, (oldEdge) => ({
        data: { ...oldEdge.data, isHovered: false },
      }))
    },
    [updateEdge],
  )

  const onEdgesDelete = useCallback(
    (edges: Edge[]) => {
      takeCoalescedSnapshot()
      applyButtonRoutes(toRouteRemovals(edges))
    },
    [applyButtonRoutes, takeCoalescedSnapshot],
  )

  const focusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((entry) => entry.id === nodeId)
      if (!node) {
        return
      }
      const sectionId = getFlowNodeSection(node)?.id
      if (sectionId) {
        setCollapsedSections((current) =>
          current.filter((id) => id !== sectionId),
        )
      }
      setNodes((current) =>
        current.map((entry) => ({ ...entry, selected: entry.id === nodeId })),
      )
      setOpenNodeDetailSheet(true)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          reactFlow.fitView({
            nodes: [{ id: nodeId }],
            padding: 0.6,
            maxZoom: 1,
            duration: 300,
          })
        }),
      )
    },
    [nodes, reactFlow, setNodes, setOpenNodeDetailSheet],
  )

  const toggleSection = useCallback(
    (sectionId: string) => {
      setCollapsedSections((current) =>
        current.includes(sectionId)
          ? current.filter((id) => id !== sectionId)
          : [...current, sectionId],
      )
      setNodes((current) =>
        current.map((node) =>
          getFlowNodeSection(node)?.id === sectionId
            ? { ...node, selected: false }
            : node,
        ),
      )
      setOpenNodeDetailSheet(false)
    },
    [setNodes, setOpenNodeDetailSheet],
  )

  const assignSection = useCallback(
    (section: FlowSection) => {
      takeSnapshot()
      setNodes((current) => assignFlowSection(current, section))
    },
    [setNodes, takeSnapshot],
  )

  const dissolveSection = useCallback(
    (sectionId: string) => {
      takeSnapshot()
      setNodes((current) => removeFlowSection(current, sectionId))
      setCollapsedSections((current) =>
        current.filter((id) => id !== sectionId),
      )
    },
    [setNodes, takeSnapshot],
  )

  return (
    <FlowMutationProvider value={flowMutationValue}>
      <FlowQolPresentationContext value={sectionView}>
        <NativeFlowCanvas
          defaultEdgeOptions={{
            markerEnd: {
              type: MarkerType.ArrowClosed,
            },
            style: {
              strokeWidth: 2,
            },
          }}
          deleteKeyCode={isFlowMutating ? null : undefined}
          edges={edges}
          edgeTypes={edgeTypes}
          elementsSelectable={!isFlowMutating}
          isMutating={isFlowMutating}
          maxZoom={10}
          minZoom={0.1}
          nodes={nodes}
          nodesConnectable={!isFlowMutating}
          nodesDraggable={!isFlowMutating}
          nodeTypes={viewerNodeTypes}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onEdgeMouseEnter={onEdgeMouseEnter}
          onEdgeMouseLeave={onEdgeMouseLeave}
          onEdgesChange={handleEdgesChange}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={handleNodeClick}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onNodesChange={handleNodesChange}
          onPaneClick={handlePaneClick}
          proOptions={{ hideAttribution: true }}
        >
          <Panel position="top-left">
            <FlowNavigationPanel
              collapsed={collapsedSections}
              disabled={isFlowMutating}
              edges={edges}
              nodes={nodes}
              onAssignSection={assignSection}
              onFocus={focusNode}
              onRemoveSection={dissolveSection}
              onToggleSection={toggleSection}
            />
          </Panel>
          <CollapsedSections onExpand={toggleSection} view={sectionView} />
        </NativeFlowCanvas>
      </FlowQolPresentationContext>
    </FlowMutationProvider>
  )
}
