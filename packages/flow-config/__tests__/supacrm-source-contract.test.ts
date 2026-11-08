import { expect, test } from "vitest"
import {
  canonicalSourceRevisionV1Schema,
  projectCanonicalSourceV1,
  sourceAuthoringPatchV1,
} from "../src/source/contract-v1"
import { compileSourceProjection, sourceKinds } from "../src/source/projection"

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Нет синтетического fixture")
  }
  return value
}
const forbiddenRuntime = /SERVER_ONLY|cursor|generation|session/

const revision = () => ({
  contract_version: "1.1.0",
  source_hash: "synthetic",
  compiler_version: "test",
  policy_revision: "test",
  scenarios: ["scenario"],
  credential_refs: ["SERVER_ONLY_CREDENTIAL"],
  source_map: [],
  diagnostics: [],
  declaration_registry_complete: true,
  semantic_parity_verified: true,
  symbols: [
    {
      symbol_id: "symbol",
      raw_key: "%ключ%",
      key: "ключ",
      declared_type: "str",
      scope: "user",
      owner: "profile",
      definition_revision: "rev",
      protected: false,
      lifetime: "declaration",
      default_policy: "reference",
      default_ref: "SERVER_ONLY_DEFAULT",
      sensitivity: "ordinary",
      read_strategy: "state",
      write_strategy: "cas",
      reset_policy: "declaration_default",
      units: null,
    },
  ],
  nodes: sourceKinds.map((kind, i) => ({
    scenario_id: "scenario",
    block_id: `block-${i}`,
    kind,
    ports: [
      {
        scenario_id: "scenario",
        block_id: `block-${i}`,
        source_path: "ports[0]",
        name: null,
        target_block_id: i === 31 ? null : `block-${i + 1}`,
        sequence: 0,
      },
      {
        scenario_id: "scenario",
        block_id: `block-${i}`,
        source_path: "ports[1]",
        name: "нет",
        target_block_id: null,
        sequence: 1,
      },
    ],
    payload_ref: "SERVER_ONLY_PAYLOAD",
    expression_refs: ["SERVER_ONLY_EXPRESSION"],
    executable: true,
  })),
})

test("T1 1.1.0 сохраняет имена и null ports всех kinds без protected references в графе", () => {
  const input = revision()
  const snapshot = JSON.stringify(input)
  const result = projectCanonicalSourceV1(input, input.source_hash)
  expect(result.publishable).toBe(true)
  expect(result.projection.nodes).toHaveLength(32)
  expect(required(result.projection.nodes[0]).ports.map((p) => p.id)).toEqual([
    "[0,null]",
    '[1,"нет"]',
  ])
  expect(JSON.stringify(result.projection)).not.toContain("SERVER_ONLY")
  expect(required(result.projection.symbols[0]).declaration?.rawKey).toBe(
    "%ключ%",
  )
  expect(JSON.stringify(input)).toBe(snapshot)
  expect(canonicalSourceRevisionV1Schema.parse(JSON.parse(snapshot))).toEqual(
    input,
  )
})

test("incomplete registry и неподтверждённый parity блокируют publish", () => {
  const result = projectCanonicalSourceV1(
    {
      ...revision(),
      declaration_registry_complete: false,
      semantic_parity_verified: false,
    },
    "synthetic",
  )
  expect(result.publishable).toBe(false)
  expect(result.diagnostics.map((d) => d.code)).toEqual([
    "registry_incomplete",
    "semantic_parity_unverified",
  ])
})

test("редакторский patch с source IDs не включает секретные ссылки и не создаёт cursor", () => {
  const input = revision()
  const projected = projectCanonicalSourceV1(
    input,
    input.source_hash,
  ).projection
  required(projected.nodes[0]).content = {
    richText: "Синтетическое сообщение",
    editMode: "edit",
  }
  const patch = sourceAuthoringPatchV1(input, projected, input.source_hash)
  expect(required(patch.updates[0]).block_id).toBe("block-0")
  expect(required(patch.updates[0]).content.richText).toBe(
    "Синтетическое сообщение",
  )
  expect(JSON.stringify(patch)).not.toMatch(forbiddenRuntime)
})

test("запрещает stale revision, подмену metadata и неизвестные kind", () => {
  const input = revision()
  const projected = projectCanonicalSourceV1(
    input,
    input.source_hash,
  ).projection
  expect(() =>
    sourceAuthoringPatchV1(input, { ...projected, sourceRevision: "stale" }),
  ).toThrow()
  required(projected.symbols[0]).owner = "forged"
  expect(() =>
    sourceAuthoringPatchV1(input, projected, input.source_hash),
  ).toThrow()
  required(input.nodes[0]).kind = "unknown" as (typeof input.nodes)[0]["kind"]
  expect(() => projectCanonicalSourceV1(input, input.source_hash)).toThrow(
    "Неподдерживаемый",
  )
})

test("unresolved policy не превращается в обычный profile setter", () => {
  const input = revision()
  required(input.symbols[0]).sensitivity = "unresolved"
  const symbol = required(
    projectCanonicalSourceV1(input, input.source_hash).projection.symbols[0],
  )
  expect(symbol.policy).toBe("secret_ref")
  expect(symbol.operations).toEqual([])
})

test("ошибки canonical IR остаются видны после повторной компиляции UI", () => {
  const input = {
    ...revision(),
    declaration_registry_complete: false,
    semantic_parity_verified: false,
  }
  const projected = projectCanonicalSourceV1(
    input,
    input.source_hash,
  ).projection
  expect(compileSourceProjection(projected).publishable).toBe(false)
})

test("отсутствующая target отличается от явного terminal null и не выбирается fallback", () => {
  const input = revision()
  required(required(input.nodes[0]).ports[0]).target_block_id = "missing-block"
  const result = projectCanonicalSourceV1(input, input.source_hash)
  expect(result.publishable).toBe(false)
  expect(result.diagnostics.map((d) => d.code)).toContain("missing_target")
  expect(
    required(result.projection.nodes[31]).ports[0]?.source?.targetBlockId,
  ).toBe(null)
  expect(
    result.projection.edges.some((e) => e.targetId === "missing-block"),
  ).toBe(true)
})

test("неисполняемый canonical node блокирует публикацию даже при flags parity", () => {
  const input = revision()
  required(input.nodes[0]).executable = false
  const result = projectCanonicalSourceV1(input, input.source_hash)
  expect(result.publishable).toBe(false)
  expect(result.diagnostics.map((d) => d.code)).toContain("node_not_executable")
})

test("неизвестный lifetime запрещает изменение даже при известной write strategy", () => {
  const input = revision()
  required(input.symbols[0]).lifetime = "unresolved"
  expect(
    projectCanonicalSourceV1(input, input.source_hash).projection.symbols[0]
      ?.operations,
  ).toEqual(["read"])
})

test("execution pin предоставляет backend, raw source hash не становится ID ревизии", () => {
  const first = revision()
  const second = { ...first, compiler_version: "new-compiler" }
  const a = projectCanonicalSourceV1(first, "backend-full-ir-pin-a")
  const b = projectCanonicalSourceV1(second, "backend-full-ir-pin-b")
  expect(first.source_hash).toBe(second.source_hash)
  expect(a.projection.sourceRevision).toBe("backend-full-ir-pin-a")
  expect(b.projection.sourceRevision).toBe("backend-full-ir-pin-b")
  expect(
    sourceAuthoringPatchV1(second, b.projection, "backend-full-ir-pin-b")
      .source_revision,
  ).toBe("backend-full-ir-pin-b")
})
