"use client"

import type { SourceNode, SourceProjection } from "@chatbotx.io/flow-config"
import {
  Background,
  Controls,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import "@xyflow/react/dist/style.css"

type SourceCanvasNode = Node<{ source: SourceNode }, "sourceProjection">

function SourceCanvasNodeViewer({
  data,
  selected,
}: NodeProps<SourceCanvasNode>) {
  const source = data.source
  return (
    <div
      className={`min-w-56 rounded-md border bg-background text-foreground shadow-sm ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
    >
      <Handle
        id={source.sourceId}
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <div className="border-b px-3 py-2">
        <div className="text-muted-foreground text-xs">{source.kind}</div>
        <strong className="block max-w-64 break-words text-sm">
          {source.label || source.sourceId}
        </strong>
      </div>
      {source.ports.map((port) => (
        <div
          className="relative flex min-h-8 justify-end border-b px-3 py-1 text-xs last:border-0"
          key={port.id}
        >
          <span>{port.label || port.id}</span>
          <Handle
            id={port.id}
            isConnectable={false}
            position={Position.Right}
            type="source"
          />
        </div>
      ))}
    </div>
  )
}

const nodeTypes = { sourceProjection: SourceCanvasNodeViewer }

/** Canvas показывает source IR; переходы и исполнение остаются у canonical backend. */
export function SupacrmSourceGraph({
  projection,
  onChange,
  selectedSourceId,
  onSelectSource,
  disabled = false,
}: {
  projection: SourceProjection
  onChange: (projection: SourceProjection) => void
  selectedSourceId?: string
  onSelectSource: (sourceId: string) => void
  disabled?: boolean
}) {
  const t = useTranslations("supacrmSource")
  const [measurements, setMeasurements] = useState<
    Map<string, { width: number; height: number }>
  >(() => new Map())
  const nodes = useMemo<SourceCanvasNode[]>(
    () =>
      projection.nodes.map((source) => ({
        id: source.sourceId,
        type: "sourceProjection",
        position: source.position,
        data: { source },
        selected: source.sourceId === selectedSourceId,
        measured: measurements.get(source.sourceId),
      })),
    [projection.nodes, selectedSourceId, measurements],
  )
  const edges = useMemo(
    () =>
      projection.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceId,
        sourceHandle: edge.portId,
        target: edge.targetId,
        targetHandle: edge.targetId,
      })),
    [projection.edges],
  )
  const changePositions = (changes: NodeChange<SourceCanvasNode>[]) => {
    const dimensions = changes.filter(
      (change) => change.type === "dimensions" && change.dimensions,
    )
    if (dimensions.length > 0) {
      setMeasurements((previous) => {
        let next = previous
        for (const change of dimensions) {
          if (change.type !== "dimensions" || !change.dimensions) {
            continue
          }
          const size = change.dimensions
          if (
            previous.get(change.id)?.width === size.width &&
            previous.get(change.id)?.height === size.height
          ) {
            continue
          }
          if (next === previous) {
            next = new Map(previous)
          }
          next.set(change.id, { width: size.width, height: size.height })
        }
        return next
      })
    }
    if (disabled) {
      return
    }
    const positions = new Map<string, { x: number; y: number }>()
    for (const change of changes) {
      if (
        change.type === "position" &&
        change.position &&
        Number.isFinite(change.position.x) &&
        Number.isFinite(change.position.y)
      ) {
        positions.set(change.id, change.position)
      }
    }
    let changed = false
    const next = projection.nodes.map((node) => {
      const position = positions.get(node.sourceId)
      if (
        !position ||
        (position.x === node.position.x && position.y === node.position.y)
      ) {
        return node
      }
      changed = true
      return { ...node, position: { x: position.x, y: position.y } }
    })
    if (changed) {
      onChange({ ...projection, nodes: next })
    }
  }
  return (
    <section aria-label={t("graph.title")} className="flex flex-col gap-2">
      <h2 className="font-semibold">{t("graph.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("graph.description")}</p>
      <div
        className="h-[560px] min-h-96 overflow-hidden rounded-md border"
        style={{ height: 560 }}
      >
        <ReactFlow<SourceCanvasNode>
          ariaLabelConfig={{
            "node.a11yDescription.default": t("graph.nodeHelp"),
            "node.a11yDescription.keyboardDisabled": t("graph.nodeHelp"),
            "node.a11yDescription.ariaLiveMessage": ({ x, y }) =>
              t("graph.nodeMoved", { x, y }),
            "edge.a11yDescription.default": t("graph.edgeHelp"),
            "controls.ariaLabel": t("graph.controls"),
            "controls.zoomIn.ariaLabel": t("graph.zoomIn"),
            "controls.zoomOut.ariaLabel": t("graph.zoomOut"),
            "controls.fitView.ariaLabel": t("graph.fitView"),
            "handle.ariaLabel": t("graph.port"),
          }}
          deleteKeyCode={null}
          edges={edges}
          edgesReconnectable={false}
          elementsSelectable
          fitView
          maxZoom={2}
          minZoom={0.05}
          multiSelectionKeyCode={null}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={!disabled}
          nodeTypes={nodeTypes}
          onlyRenderVisibleElements
          onNodeClick={(_event, node) => onSelectSource(node.id)}
          onNodesChange={changePositions}
          proOptions={{ hideAttribution: true }}
          selectionKeyCode={null}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  )
}
