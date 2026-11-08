import {
  type FlowNavigationEdge,
  type FlowNavigationNode,
  queryFlowGraph,
} from "@chatbotx.io/flow-config"

import { describeFlowConnection } from "./connection-label"

type PositionedNode = FlowNavigationNode & {
  position: { x: number; y: number }
}
type EdgePosition = {
  sourceX?: number
  sourceY?: number
  targetX?: number
  targetY?: number
}
export type SectionView = {
  id: string
  title: string
  nodeIds: string[]
  x: number
  y: number
  width: number
  height: number
  ports: {
    edgeId: string
    direction: "source" | "target"
    label: string
    technicalDescription: string
    y: number
  }[]
}

/** Geometry only: all persisted node/edge/handle identities remain untouched. */
export function buildCollapsedSectionView(
  nodes: readonly PositionedNode[],
  edges: readonly FlowNavigationEdge[],
  collapsed: readonly string[],
) {
  const { sections: allSections } = queryFlowGraph({ nodes, edges })
  const hiddenNodeIds = new Set<string>()
  const hiddenEdgeIds = new Set<string>()
  const edgePositions = new Map<string, EdgePosition>()
  const sections = allSections
    .filter((section) => collapsed.includes(section.id))
    .map((section): SectionView => {
      const members = nodes.filter((node) => section.nodeIds.includes(node.id))
      const memberIds = new Set(section.nodeIds)
      for (const id of memberIds) {
        hiddenNodeIds.add(id)
      }
      const x = Math.min(...members.map((node) => node.position.x))
      const y = Math.min(...members.map((node) => node.position.y))
      const ports: SectionView["ports"] = []
      for (const edge of edges) {
        const sourceInside = memberIds.has(edge.source)
        const targetInside = memberIds.has(edge.target)
        if (sourceInside && targetInside) {
          hiddenEdgeIds.add(edge.id)
          continue
        }
        if (!(sourceInside || targetInside)) {
          continue
        }
        const direction = sourceInside ? "source" : "target"
        const portY = 64 + ports.length * 24
        ports.push({
          edgeId: edge.id,
          direction,
          ...describeFlowConnection(nodes, edge),
          y: portY,
        })
        edgePositions.set(edge.id, {
          ...edgePositions.get(edge.id),
          ...(sourceInside
            ? { sourceX: x + 320, sourceY: y + portY }
            : { targetX: x, targetY: y + portY }),
        })
      }
      return {
        ...section,
        x,
        y,
        width: 320,
        height: Math.max(88, 80 + ports.length * 24),
        ports,
      }
    })
  return { sections, hiddenNodeIds, hiddenEdgeIds, edgePositions }
}

export type CollapsedSectionView = ReturnType<typeof buildCollapsedSectionView>
