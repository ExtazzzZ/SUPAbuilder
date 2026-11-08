"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { NativeFlowCanvas } from "../../react-flow/native-flow-canvas"
import FocusButton from "../../react-flow/panel-buttons/focus-button"
import ZoomInButton from "../../react-flow/panel-buttons/zoom-in-button"
import ZoomOutButton from "../../react-flow/panel-buttons/zoom-out-button"
import { isSourceCanvasNode } from "./projection-adapter"
import { SourceNodeCard } from "./source-node-card"
import type { NativeSourceProjection, SourceCanvasNodeData } from "./types"

export interface NativeSourceCanvasViewProps {
  onSourcePane?: () => void
  onSourceSelect: (data: SourceCanvasNodeData) => void
  selectedNodeId?: string
  sourceDocument: NativeSourceProjection
  sourceLocked: boolean
}
const nodeTypes = { sourceProjection: SourceNodeCard }

/** Source controller не монтирует legacy autosave/history/CRUD; canvas общий. */
export function NativeSourceCanvasView({
  sourceDocument,
  sourceLocked,
  selectedNodeId,
  onSourceSelect,
  onSourcePane,
}: NativeSourceCanvasViewProps) {
  const t = useTranslations("supacrmNativeSource.canvas")
  const nodes = useMemo(
    () =>
      sourceDocument.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      })),
    [sourceDocument.nodes, selectedNodeId],
  )
  return (
    <NativeFlowCanvas
      controls={
        <>
          <FocusButton />
          <ZoomInButton />
          <ZoomOutButton />
          <Button
            aria-label={t("addUnavailable")}
            disabled
            size="icon"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
          </Button>
        </>
      }
      deleteKeyCode={null}
      edges={sourceDocument.edges}
      edgesReconnectable={false}
      elementsSelectable={!sourceLocked}
      isMutating={sourceLocked}
      nodes={nodes}
      nodesConnectable={false}
      nodesDraggable={false}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => {
        if (!sourceLocked && isSourceCanvasNode(node)) {
          onSourceSelect(node.data)
        }
      }}
      onPaneClick={() => {
        if (!sourceLocked) {
          onSourcePane?.()
        }
      }}
    >
      {sourceDocument.unresolvedEdges.length > 0 && (
        <div
          className="absolute end-3 top-3 rounded-md border bg-background p-2 text-sm"
          role="status"
        >
          {t("unresolvedConnections")}: {sourceDocument.unresolvedEdges.length}
        </div>
      )}
    </NativeFlowCanvas>
  )
}
