import { expect, test } from "vitest"
import {
  buildSourceAuthoringPatchV1,
  buildSourceLogicCompileRequestV1,
} from "../src/source/authoring"

import { parseSourceLogicProjectionV1 } from "../src/source/logic"

const base = () => ({
  version: "supacrm.source-authoring.v1",
  draft_version: 3,
  source_revision: "source",
  diagnostics: [{ code: "unverified" }],
  publishable: false,
  projection: {
    version: "supacrm.source-projection.v1",
    sourceRevision: "source",
    nodes: [
      {
        sourceId: "block",
        scenarioId: "scenario",
        kind: "send_message",
        label: "Блок",
        ports: [],
        bindings: [],
        content: {},
        position: { x: 0, y: 0 },
      },
    ],
    symbols: [],
    edges: [],
    sourceValidation: {
      registryComplete: false,
      semanticParityVerified: false,
      diagnostics: [{ code: "redacted_source", blockId: "block" }],
    },
  },
})

test("черновик сохраняет existing canonical blockers без выдачи разрешения publish", () => {
  const envelope = base()
  expect(
    buildSourceAuthoringPatchV1(envelope, envelope.projection),
  ).toMatchObject({ expected_draft_version: 3, source_revision: "source" })
})

test("подмена структуры/metadata и runtime values не попадает в patch", () => {
  const envelope = base()
  expect(() =>
    buildSourceAuthoringPatchV1(envelope, {
      ...envelope.projection,
      sourceRevision: "stale",
    }),
  ).toThrow()
  expect(() =>
    buildSourceAuthoringPatchV1(envelope, {
      ...envelope.projection,
      values: {},
    }),
  ).toThrow()
  expect(() =>
    buildSourceAuthoringPatchV1(envelope, {
      ...envelope.projection,
      sourceValidation: undefined,
    }),
  ).toThrow()
})

const rawHash = "a".repeat(64)
const fullPin = "b".repeat(64)
const span = {
  scenario_id: "scenario",
  block_id: "block",
  path: "params.expr",
  start: 0,
  end: 0,
  sequence: 0,
}
function logicEnvelope() {
  return {
    ...base(),
    source_revision: fullPin,
    source_hash: rawHash,
    projection: { ...base().projection, sourceRevision: fullPin },
    logic: {
      dto_version: "1.0.0",
      source_hash: rawHash,
      publishable: false,
      diagnostics: [],
      edits: [
        {
          kind: "guard",
          expected_source_hash: rawHash,
          target: span,
          expression: {
            kind: "literal_slot",
            slot_id: "existing-slot",
            declared_type: "bool",
          },
        },
      ],
    },
  }
}

test("compile request использует server fullpin отдельно от source hash; unchanged edits не пересылаются", () => {
  const envelope = logicEnvelope()
  const edited = parseSourceLogicProjectionV1(envelope.logic)
  const rule = edited.edits[0]
  if (rule?.kind !== "guard") {
    throw new Error("Нет fixture")
  }
  rule.expression = { kind: "unary", operator: "not", operand: rule.expression }
  const request = buildSourceLogicCompileRequestV1(envelope, edited)
  expect(request.source_revision).toBe(fullPin)
  expect(request.edits[0]?.expected_source_hash).toBe(rawHash)
  expect(request.edits).toHaveLength(1)
  expect(
    buildSourceLogicCompileRequestV1(envelope, envelope.logic).edits,
  ).toEqual([])
})

test("stale logic hash, подмена target и source hash отклоняются до server mutation", () => {
  const envelope = logicEnvelope()
  expect(() =>
    buildSourceLogicCompileRequestV1(envelope, {
      ...envelope.logic,
      source_hash: "c".repeat(64),
    }),
  ).toThrow()
  expect(() =>
    buildSourceLogicCompileRequestV1(envelope, {
      ...envelope.logic,
      edits: [
        {
          ...envelope.logic.edits[0],
          target: { ...span, path: "arbitrary.setter" },
        },
      ],
    }),
  ).toThrow()
  expect(() =>
    buildSourceLogicCompileRequestV1(envelope, {
      ...envelope.logic,
      edits: [
        { ...envelope.logic.edits[0], expected_source_hash: "d".repeat(64) },
      ],
    }),
  ).toThrow()
  expect(() =>
    buildSourceLogicCompileRequestV1(
      { ...envelope, logic: undefined },
      envelope.logic,
    ),
  ).toThrow()
})

test("transition original port immutable, изменяется только target", () => {
  const port = {
    scenario_id: "scenario",
    block_id: "block",
    source_path: "transitions.yes",
    name: "yes",
    target_block_id: "block",
    sequence: 0,
  }
  const edit = {
    kind: "transition",
    expected_source_hash: rawHash,
    target: { ...span, path: port.source_path },
    port,
    target_block_id: "block",
  }
  const envelope = {
    ...logicEnvelope(),
    logic: { ...logicEnvelope().logic, edits: [edit] },
  }
  expect(
    buildSourceLogicCompileRequestV1(envelope, {
      ...envelope.logic,
      edits: [{ ...edit, target_block_id: null }],
    }).edits[0],
  ).toMatchObject({ target_block_id: null, port })
  expect(() =>
    buildSourceLogicCompileRequestV1(envelope, {
      ...envelope.logic,
      edits: [{ ...edit, port: { ...port, name: "no" } }],
    }),
  ).toThrow()
})

test("неизвестный symbol в новой binding не может войти даже в draft patch", () => {
  const envelope = base()
  const edited = {
    ...envelope.projection,
    nodes: envelope.projection.nodes.map((n) => ({
      ...n,
      bindings: [{ symbolId: "missing", operation: "set" }],
    })),
  }
  expect(() => buildSourceAuthoringPatchV1(envelope, edited)).toThrow(
    "Неверный авторский patch",
  )
  expect(() =>
    buildSourceAuthoringPatchV1(
      {
        ...envelope,
        projection: {
          ...envelope.projection,
          nodes: envelope.projection.nodes.map((n) => ({
            ...n,
            scenarioId: undefined,
          })),
        },
      },
      {
        ...envelope.projection,
        nodes: envelope.projection.nodes.map((n) => ({
          ...n,
          scenarioId: undefined,
        })),
      },
    ),
  ).toThrow("Отсутствует исходный сценарий")
})
