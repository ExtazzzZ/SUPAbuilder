// @vitest-environment node
import {
  type SourceAuthoringEnvelopeV1,
  sourceKinds,
  sourcePortHandleV1,
} from "@chatbotx.io/flow-config"
import { expect, test } from "vitest"
import {
  isSourceCanvasNode,
  nativeSourceNodeId,
  nativeSourceScopeKey,
  toNativeSourceProjection,
} from "../src/features/flows/supacrm-source/native/projection-adapter"
import type { NativeSourceBinding } from "../src/features/flows/supacrm-source/native/types"

const binding: NativeSourceBinding = {
  bindingId: "binding",
  registryId: "registry",
  workspaceId: "workspace",
  flowId: "flow",
}
function fixture(): SourceAuthoringEnvelopeV1 {
  const nodes = sourceKinds.map((kind, index) => ({
    sourceId: `node-${index}`,
    scenarioId: "scenario",
    kind,
    label: `Название ${index}`,
    ports: [
      {
        id: sourcePortHandleV1(0, null),
        label: "∅",
        source: {
          scenarioId: "scenario",
          blockId: `node-${index}`,
          path: "ports.0",
          sequence: 0,
          name: null,
          targetBlockId:
            index < sourceKinds.length - 1 ? `node-${index + 1}` : null,
        },
      },
      {
        id: sourcePortHandleV1(1, "default"),
        label: "Иначе",
        source: {
          scenarioId: "scenario",
          blockId: `node-${index}`,
          path: "ports.1",
          sequence: 1,
          name: "default",
          targetBlockId: null,
        },
      },
    ],
    content: {
      richText: "synthetic-plaintext",
      buttons: [
        {
          id: "button",
          label: "synthetic-button-text",
          portId: sourcePortHandleV1(0, null),
        },
      ],
      media: [
        {
          id: "asset",
          kind: "file" as const,
          assetRef: "synthetic-artifact-ref",
        },
      ],
    },
    bindings: [{ symbolId: "synthetic-variable", operation: "read" as const }],
    position: { x: index * 300, y: 10 },
  }))
  return {
    version: "supacrm.source-authoring.v1",
    source_revision: "full-pin-1",
    source_hash: "raw-hash-1",
    draft_version: 7,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: "full-pin-1",
      nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({
        id: JSON.stringify([node.scenarioId, node.sourceId, 0, null]),
        sourceId: node.sourceId,
        portId: sourcePortHandleV1(0, null),
        targetId: `node-${index + 1}`,
      })),
      symbols: [],
    },
    diagnostics: [],
    publishable: false,
  }
}
function required<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error("Нет результата проверки")
  }
  return value
}

test("adapter сохраняет все32kinds, порядок и точную provenance портов/рёбер", () => {
  const envelope = fixture(),
    view = toNativeSourceProjection(binding, envelope)
  expect(view.nodes).toHaveLength(32)
  expect(view.nodes.map((node) => node.data.sourceKind)).toEqual(sourceKinds)
  expect(view.nodes.map((node) => node.data.sourceId)).toEqual(
    envelope.projection.nodes.map((node) => node.sourceId),
  )
  expect(view.edges).toHaveLength(31)
  for (const [nodeIndex, node] of view.nodes.entries()) {
    expect(node.type).toBe("sourceProjection")
    expect(node.position).toEqual(
      envelope.projection.nodes[nodeIndex]?.position,
    )
    for (const [portIndex, port] of node.data.ports.entries()) {
      const original = required(
        envelope.projection.nodes[nodeIndex]?.ports[portIndex].source,
      )
      expect(port.source).toEqual({
        scenario_id: original.scenarioId,
        block_id: original.blockId,
        source_path: original.path,
        name: original.name,
        target_block_id: original.targetBlockId,
        sequence: original.sequence,
      })
      expect(port.projectionPortId).toBe(
        envelope.projection.nodes[nodeIndex]?.ports[portIndex].id,
      )
      expect(JSON.parse(decodeURIComponent(port.handleId))).toEqual([
        "source-port",
        original.scenarioId,
        original.blockId,
        original.path,
        original.sequence,
        original.name,
      ])
    }
  }
  const first = required(view.edges[0]),
    node = required(view.nodes[0])
  expect(first.source).toBe(node.id)
  expect(first.sourceHandle).toBe(node.data.ports[0]?.handleId)
  expect(first.target).toBe(view.nodes[1]?.id)
  expect(first.targetHandle).toBe(first.target)
  expect(first.deletable).toBe(false)
  expect(first.reconnectable).toBe(false)
})

test("canvas data не содержит plaintext, slots, bindings, details или полный envelope", () => {
  const envelope = fixture(),
    extendedBinding = {
      ...binding,
      bindingVersion: "future-safe-version",
      capabilities: {},
      token: "synthetic-private-binding-extra",
    }
  const view = toNativeSourceProjection(extendedBinding, envelope),
    serialized = JSON.stringify(view)
  for (const text of [
    "synthetic-plaintext",
    "synthetic-button-text",
    "synthetic-artifact-ref",
    "synthetic-variable",
    "synthetic-private-binding-extra",
    "content",
    "details",
    "slot_id",
    "source_hash",
    "expected_full_ir_id",
  ]) {
    expect(serialized).not.toContain(text)
  }
  expect(Object.keys(required(view.nodes[0]).data).sort()).toEqual(
    [
      "documentMode",
      "bindingId",
      "registryId",
      "scenarioId",
      "sourceId",
      "sourceKind",
      "label",
      "scopeKey",
      "ports",
    ].sort(),
  )
})

test("UI IDs стабильны при новомpin/draft, scopeKey меняется для перепривязки панели", () => {
  const first = fixture(),
    second = fixture()
  second.source_revision = "full-pin-2"
  second.projection.sourceRevision = second.source_revision
  second.draft_version++
  const before = toNativeSourceProjection(binding, first),
    after = toNativeSourceProjection(binding, second)
  expect(before.nodes.map((node) => node.id)).toEqual(
    after.nodes.map((node) => node.id),
  )
  expect(before.edges.map((edge) => edge.id)).toEqual(
    after.edges.map((edge) => edge.id),
  )
  expect(before.scopeKey).not.toBe(after.scopeKey)
  expect(before.scopeKey).toBe(nativeSourceScopeKey(binding, first))
  expect(before.nodes[0]?.id).toBe(
    nativeSourceNodeId(binding, "scenario", "node-0"),
  )
  expect(
    nativeSourceNodeId(
      { ...binding, registryId: "foreign" },
      "scenario",
      "node-0",
    ),
  ).not.toBe(before.nodes[0]?.id)
  expect(nativeSourceNodeId(binding, "foreign", "node-0")).not.toBe(
    before.nodes[0]?.id,
  )
})

test("null, строкаnull, default, sequence и sourcepath не теряют идентичность", () => {
  const envelope = fixture(),
    node = required(envelope.projection.nodes[0])
  envelope.projection.nodes = [node]
  envelope.projection.edges = []
  node.ports = [null, "null", "default", null].map((name, index) => ({
    id: `projection-${index}`,
    label: name ?? "∅",
    source: {
      scenarioId: "scenario",
      blockId: node.sourceId,
      path: `ports.${index}`,
      sequence: 0,
      name,
      targetBlockId: null,
    },
  }))
  const result = toNativeSourceProjection(binding, envelope)
  expect(
    new Set(result.nodes[0]?.data.ports.map((port) => port.handleId)).size,
  ).toBe(4)
  expect(result.edges).toEqual([])
  expect(result.nodes[0]?.data.ports.map((port) => port.source.name)).toEqual([
    null,
    "null",
    "default",
    null,
  ])
})

test("отсутствующая цель остаётся dangling edge без поддельного узла; null terminal не создаёт edge", () => {
  const envelope = fixture()
  envelope.projection.nodes.splice(1)
  envelope.projection.edges.splice(1)
  const result = toNativeSourceProjection(binding, envelope)
  expect(result.nodes).toHaveLength(1)
  expect(result.edges).toHaveLength(0)
  expect(result.unresolvedEdges).toHaveLength(1)
  expect(result.unresolvedEdges[0]?.targetSourceId).toBe("node-1")
  expect(result.unresolvedEdges[0]?.code).toBe("missing_target")
})

test("изолирует одинаковыеblockIDs разныхscenario и привязывает canonical edge по provenance", () => {
  const envelope = fixture(),
    source = required(envelope.projection.nodes[0]),
    target = required(envelope.projection.nodes[1])
  source.sourceId = "same"
  target.sourceId = "target"
  source.ports[0] = {
    ...required(source.ports[0]),
    source: {
      scenarioId: "scenario",
      blockId: "same",
      path: "ports.0",
      sequence: 0,
      name: null,
      targetBlockId: "target",
    },
  }
  source.ports = source.ports.slice(0, 1)
  target.ports = []
  const foreign = structuredClone(source)
  foreign.scenarioId = "other"
  required(foreign.ports[0]).source = {
    ...required(foreign.ports[0]?.source),
    scenarioId: "other",
  }
  const foreignTarget = { ...structuredClone(target), scenarioId: "other" }
  envelope.projection.nodes = [source, target, foreign, foreignTarget]
  envelope.projection.edges = [
    {
      id: JSON.stringify(["other", "same", 0, null]),
      sourceId: "same",
      portId: sourcePortHandleV1(0, null),
      targetId: "target",
    },
  ]
  const result = toNativeSourceProjection(binding, envelope)
  expect(new Set(result.nodes.map((node) => node.id)).size).toBe(4)
  expect(result.edges[0]?.source).toBe(
    nativeSourceNodeId(binding, "other", "same"),
  )
  expect(result.edges[0]?.target).toBe(
    nativeSourceNodeId(binding, "other", "target"),
  )
})

test.each([
  "missing_scenario",
  "missing_port_source",
  "foreign_port_scope",
  "duplicate_node",
  "ambiguous_edge",
  "terminal_edge",
  "wrong_target",
])("не угадывает identity при ошибке %s", (kind) => {
  const envelope = fixture(),
    node = required(envelope.projection.nodes[0]),
    port = required(node.ports[0])
  if (kind === "missing_scenario") {
    node.scenarioId = undefined
  }
  if (kind === "missing_port_source") {
    port.source = undefined
  }
  if (kind === "foreign_port_scope") {
    required(port.source).blockId = "foreign"
  }
  if (kind === "duplicate_node") {
    envelope.projection.nodes.push(structuredClone(node))
  }
  if (kind === "ambiguous_edge") {
    const foreign = structuredClone(node)
    foreign.scenarioId = "foreign"
    for (const p of foreign.ports) {
      required(p.source).scenarioId = "foreign"
    }
    envelope.projection.nodes.push(foreign)
    required(envelope.projection.edges[0]).id = "ambiguous"
  }
  if (kind === "terminal_edge") {
    required(port.source).targetBlockId = null
  }
  if (kind === "wrong_target") {
    required(envelope.projection.edges[0]).targetId = "foreign"
  }
  expect(() => toNativeSourceProjection(binding, envelope)).toThrow()
})

test("strict envelope и core binding проверяются до проекции без изменения входных данных", () => {
  const envelope = fixture(),
    saved = structuredClone(envelope)
  expect(() =>
    toNativeSourceProjection({ ...binding, registryId: "" }, envelope),
  ).toThrow()
  expect(() =>
    toNativeSourceProjection(binding, {
      ...envelope,
      token: "private",
    } as SourceAuthoringEnvelopeV1),
  ).toThrow()
  toNativeSourceProjection(binding, envelope)
  expect(envelope).toEqual(saved)
})

test("UI guard отделяет source selections от legacy/неполных объектов без выдачи authority", () => {
  const node = required(toNativeSourceProjection(binding, fixture()).nodes[0])
  expect(isSourceCanvasNode(node)).toBe(true)
  for (const value of [
    null,
    "node",
    {},
    { id: 1, type: "sourceProjection", data: node.data },
    { id: "id", type: "sendMessage", data: node.data },
    { id: "id", type: "sourceProjection" },
    { id: "id", type: "sourceProjection", data: null },
    { id: "id", type: "sourceProjection", data: "invalid" },
    { ...node, data: { ...node.data, documentMode: "legacy" } },
    { ...node, data: { ...node.data, label: undefined } },
    { ...node, data: { ...node.data, sourceKind: "unknown" } },
    { ...node, data: { ...node.data, ports: null } },
  ]) {
    expect(isSourceCanvasNode(value)).toBe(false)
  }
})

test("scopeKey различает raw hash и отсутствие hash, сохраняя stable IDs", () => {
  const envelope = fixture(),
    withoutHash = { ...envelope, source_hash: undefined },
    changedHash = { ...envelope, source_hash: "other" }
  expect(nativeSourceScopeKey(binding, envelope)).not.toBe(
    nativeSourceScopeKey(binding, withoutHash),
  )
  expect(nativeSourceScopeKey(binding, envelope)).not.toBe(
    nativeSourceScopeKey(binding, changedHash),
  )
  expect(toNativeSourceProjection(binding, withoutHash).nodes[0]?.id).toBe(
    toNativeSourceProjection(binding, envelope).nodes[0]?.id,
  )
})

test.each([
  "duplicate_handle",
  "duplicate_edge",
  "unknown_source",
])("несогласованная identity %s отклоняется безопасной общей ошибкой", (kind) => {
  const envelope = fixture()
  if (kind === "duplicate_handle") {
    required(envelope.projection.nodes[0]).ports.push(
      structuredClone(required(envelope.projection.nodes[0]?.ports[0])),
    )
  }
  if (kind === "duplicate_edge") {
    envelope.projection.edges.push(
      structuredClone(required(envelope.projection.edges[0])),
    )
  }
  if (kind === "unknown_source") {
    required(envelope.projection.edges[0]).sourceId = "missing"
  }
  expect(() => toNativeSourceProjection(binding, envelope)).toThrow(
    "native_source_projection_invalid",
  )
})

test("однозначный cross-scenario target отображается без подмены source provenance", () => {
  const envelope = fixture(),
    target = required(envelope.projection.nodes[1])
  target.scenarioId = "other"
  target.ports = []
  envelope.projection.nodes.splice(2)
  envelope.projection.edges.splice(1)
  const result = toNativeSourceProjection(binding, envelope)
  expect(result.edges[0]?.target).toBe(
    nativeSourceNodeId(binding, "other", "node-1"),
  )
  expect(result.unresolvedEdges).toEqual([])
  expect(result.edges[0]?.data?.source.scenario_id).toBe("scenario")
})

test("ambiguous target сохраняется отдельно вместо произвольного выбора или ReactFlow warning", () => {
  const envelope = fixture(),
    source = required(envelope.projection.nodes[0]),
    target = required(envelope.projection.nodes[1])
  target.scenarioId = "first"
  target.ports = []
  const other = { ...structuredClone(target), scenarioId: "second" }
  envelope.projection.nodes = [source, target, other]
  envelope.projection.edges.splice(1)
  const result = toNativeSourceProjection(binding, envelope)
  expect(result.edges).toEqual([])
  expect(result.unresolvedEdges[0]?.code).toBe("ambiguous_target")
  expect(result.edges.length + result.unresolvedEdges.length).toBe(
    envelope.projection.edges.length,
  )
})
