"use client"

import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  Panel,
  ReactFlow,
  type ReactFlowProps,
} from "@xyflow/react"
import type { ReactNode } from "react"
import AddNodeButton from "./panel-buttons/add-node-button"
import FocusButton from "./panel-buttons/focus-button"
import ZoomInButton from "./panel-buttons/zoom-in-button"
import ZoomOutButton from "./panel-buttons/zoom-out-button"

export type NativeFlowCanvasProps<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
> = ReactFlowProps<NodeType, EdgeType> & {
  isMutating: boolean
  controls?: ReactNode
}

/** Общий существующий canvas SUPAbuilder; persistence принадлежит выбранному controller. */
export function NativeFlowCanvas<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
>({
  isMutating,
  controls,
  children,
  ...props
}: NativeFlowCanvasProps<NodeType, EdgeType>) {
  return (
    <ReactFlow<NodeType, EdgeType>
      defaultEdgeOptions={{
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      }}
      maxZoom={10}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      {...props}
    >
      {isMutating && (
        <div
          className="absolute inset-0 z-50 cursor-wait bg-white/40 dark:bg-black/40"
          data-testid="flow-mutation-overlay"
        />
      )}
      <Background />
      <Panel className="w-[254px]" position="bottom-center">
        <Controls
          className="overflow-hidden rounded-md shadow-none!"
          orientation="horizontal"
          showFitView={false}
          showInteractive={false}
          showZoom={false}
        >
          {controls ?? (
            <>
              <FocusButton />
              <ZoomInButton />
              <ZoomOutButton />
              <AddNodeButton />
            </>
          )}
        </Controls>
      </Panel>
      {children}
    </ReactFlow>
  )
}
