import {
  type SourceAuthoringEnvelopeV1,
  sourceAuthoringEnvelopeV1Schema,
  sourceKinds,
} from "@chatbotx.io/flow-config"
import { z } from "zod"
import type {
  NativeSourceBinding,
  NativeSourcePort,
  NativeSourceProjection,
  SourceCanvasNode,
} from "./types"

const coreBinding = z.strictObject({
  bindingId: z.string().min(1),
  registryId: z.string().min(1),
  workspaceId: z.string().min(1),
  flowId: z.string().min(1),
})
function invalid(): never {
  throw new Error("native_source_projection_invalid")
}
/** DOM-safe encoding сохраняет tuple identity без кавычек внутри штатных CSS selectors. */
const stableUiId = (parts: (string | number | null)[]) =>
  encodeURIComponent(JSON.stringify(parts))
/** Стабильная UI identity не зависит от revision; исходные идентификаторы остаются отдельными полями. */
export function nativeSourceNodeId(
  binding: NativeSourceBinding,
  scenarioId: string,
  sourceId: string,
): string {
  return stableUiId([
    "source-node",
    binding.bindingId,
    binding.registryId,
    scenarioId,
    sourceId,
  ])
}
export function nativeSourceScopeKey(
  binding: NativeSourceBinding,
  envelope: SourceAuthoringEnvelopeV1,
): string {
  return JSON.stringify([
    "source-scope",
    binding.bindingId,
    binding.registryId,
    binding.workspaceId,
    binding.flowId,
    envelope.source_revision,
    envelope.source_hash ?? null,
    envelope.draft_version,
  ])
}
/** Только UI guard; команды дополнительно сверяют выбранный узел с canonical context. */
export function isSourceCanvasNode(value: unknown): value is SourceCanvasNode {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("type" in value) ||
    value.type !== "sourceProjection" ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object"
  ) {
    return false
  }
  const data = value.data as Record<string, unknown>
  return (
    data.documentMode === "source" &&
    [
      "bindingId",
      "registryId",
      "scenarioId",
      "sourceId",
      "sourceKind",
      "label",
      "scopeKey",
    ].every((key) => typeof data[key] === "string") &&
    sourceKinds.includes(data.sourceKind as (typeof sourceKinds)[number]) &&
    Array.isArray(data.ports)
  )
}

/** Проецирует существующий документ в native canvas, не пересобирая IR и не выдавая authority. */
export function toNativeSourceProjection(
  binding: NativeSourceBinding,
  input: SourceAuthoringEnvelopeV1,
): NativeSourceProjection {
  let bound: NativeSourceBinding, envelope: SourceAuthoringEnvelopeV1
  try {
    bound = coreBinding.parse({
      bindingId: binding.bindingId,
      registryId: binding.registryId,
      workspaceId: binding.workspaceId,
      flowId: binding.flowId,
    })
    envelope = sourceAuthoringEnvelopeV1Schema.parse(input)
  } catch {
    return invalid()
  }
  const scopeKey = nativeSourceScopeKey(bound, envelope)
  const result: NativeSourceProjection = {
    nodes: [],
    edges: [],
    unresolvedEdges: [],
    scopeKey,
  }
  const byId = new Map<string, SourceCanvasNode>()
  const bySource = new Map<string, SourceCanvasNode[]>()
  for (const node of envelope.projection.nodes) {
    if (!node.scenarioId) {
      return invalid()
    }
    const id = nativeSourceNodeId(bound, node.scenarioId, node.sourceId)
    if (byId.has(id)) {
      return invalid()
    }
    const handles = new Set<string>()
    const ports: NativeSourcePort[] = node.ports.map((port) => {
      const provenance = port.source
      if (
        !provenance ||
        provenance.scenarioId !== node.scenarioId ||
        provenance.blockId !== node.sourceId
      ) {
        return invalid()
      }
      const source = {
        scenario_id: provenance.scenarioId,
        block_id: provenance.blockId,
        source_path: provenance.path,
        name: provenance.name,
        target_block_id: provenance.targetBlockId,
        sequence: provenance.sequence,
      }
      const handleId = stableUiId([
        "source-port",
        source.scenario_id,
        source.block_id,
        source.source_path,
        source.sequence,
        source.name,
      ])
      if (handles.has(handleId)) {
        return invalid()
      }
      handles.add(handleId)
      return { projectionPortId: port.id, handleId, label: port.label, source }
    })
    const canvasNode: SourceCanvasNode = {
      id,
      type: "sourceProjection",
      position: { ...node.position },
      deletable: false,
      connectable: false,
      data: {
        documentMode: "source",
        bindingId: bound.bindingId,
        registryId: bound.registryId,
        scenarioId: node.scenarioId,
        sourceId: node.sourceId,
        sourceKind: node.kind,
        label: node.label,
        scopeKey,
        ports,
      },
    }
    result.nodes.push(canvasNode)
    byId.set(id, canvasNode)
    bySource.set(node.sourceId, [
      ...(bySource.get(node.sourceId) ?? []),
      canvasNode,
    ])
  }
  const edgeIds = new Set<string>()
  for (const edge of envelope.projection.edges) {
    let candidates = (bySource.get(edge.sourceId) ?? []).flatMap((node) =>
      node.data.ports
        .filter((port) => port.projectionPortId === edge.portId)
        .map((port) => ({ node, port })),
    )
    if (candidates.length > 1) {
      candidates = candidates.filter(
        ({ port }) =>
          edge.id ===
          JSON.stringify([
            port.source.scenario_id,
            port.source.block_id,
            port.source.sequence,
            port.source.name,
          ]),
      )
    }
    if (candidates.length !== 1) {
      return invalid()
    }
    const candidate = candidates[0]
    if (!candidate) {
      return invalid()
    }
    const { node, port } = candidate
    if (
      port.source.target_block_id === null ||
      port.source.target_block_id !== edge.targetId
    ) {
      return invalid()
    }
    const id = stableUiId([
      "source-edge",
      bound.bindingId,
      bound.registryId,
      node.data.scenarioId,
      node.data.sourceId,
      edge.id,
    ])
    if (edgeIds.has(id)) {
      return invalid()
    }
    edgeIds.add(id)
    const targets = bySource.get(edge.targetId) ?? []
    const scoped = targets.filter(
      (target) => target.data.scenarioId === node.data.scenarioId,
    )
    let target: SourceCanvasNode | undefined
    if (scoped.length === 1) {
      target = scoped[0]
    } else if (targets.length === 1) {
      target = targets[0]
    }
    if (!target) {
      result.unresolvedEdges.push({
        id,
        projectionEdgeId: edge.id,
        sourceNodeId: node.id,
        sourceHandle: port.handleId,
        source: { ...port.source },
        targetSourceId: edge.targetId,
        code: targets.length ? "ambiguous_target" : "missing_target",
      })
      continue
    }
    result.edges.push({
      id,
      source: node.id,
      sourceHandle: port.handleId,
      target: target.id,
      targetHandle: target.id,
      deletable: false,
      reconnectable: false,
      selectable: false,
      focusable: false,
      data: {
        documentMode: "source",
        bindingId: bound.bindingId,
        registryId: bound.registryId,
        scopeKey,
        projectionEdgeId: edge.id,
        source: { ...port.source },
      },
    })
  }
  return result
}
