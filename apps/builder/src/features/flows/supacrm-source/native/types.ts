import type { SourceNode, sourcePortV1Schema } from "@chatbotx.io/flow-config"
import type { Edge, Node } from "@xyflow/react"
import type { z } from "zod"

/** Серверная привязка документа; форма descriptor не является authority на команды. */
export interface NativeSourceBinding {
  bindingId: string
  flowId: string
  registryId: string
  workspaceId: string
}
export interface NativeSourcePort {
  handleId: string
  label: string
  projectionPortId: string
  source: z.infer<typeof sourcePortV1Schema>
}
/** Только метаданные native canvas: текст, slots, grants и полный envelope сюда не копируются. */
export interface SourceCanvasNodeData extends Record<string, unknown> {
  bindingId: string
  documentMode: "source"
  label: string
  ports: NativeSourcePort[]
  registryId: string
  scenarioId: string
  scopeKey: string
  sourceId: string
  sourceKind: SourceNode["kind"]
}
export type SourceCanvasNode = Node<SourceCanvasNodeData, "sourceProjection">
export interface NativeSourceEdgeData extends Record<string, unknown> {
  bindingId: string
  documentMode: "source"
  projectionEdgeId: string
  registryId: string
  scopeKey: string
  source: z.infer<typeof sourcePortV1Schema>
}
export interface NativeSourceUnresolvedEdge {
  code: "missing_target" | "ambiguous_target"
  id: string
  projectionEdgeId: string
  source: z.infer<typeof sourcePortV1Schema>
  sourceHandle: string
  sourceNodeId: string
  targetSourceId: string
}
export interface NativeSourceProjection {
  edges: Edge<NativeSourceEdgeData>[]
  nodes: SourceCanvasNode[]
  scopeKey: string
  unresolvedEdges: NativeSourceUnresolvedEdge[]
}
