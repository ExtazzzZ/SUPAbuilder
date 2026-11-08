import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { z } from "zod"
import {
  collectSourceLiteralSlotsV1,
  parseSourceLogicProjectionV1,
  type SourceTypedExprV1,
  sourceLogicProjectionV1Schema,
  sourceTypedExprV1Schema,
} from "../src/source/logic"

const schemaBytes = readFileSync(
  new URL("./fixtures/source-authoring-v1.schema.txt", import.meta.url),
)
const bundle = JSON.parse(schemaBytes.toString())
const canonical = z.fromJSONSchema(bundle.schemas.AuthoringProjection)
const hash = "a".repeat(64)
const symbol = { kind: "symbol", symbol_id: "symbol" } as const
const slot = {
  kind: "literal_slot",
  slot_id: "authoring-slot",
  declared_type: "num",
} as const
const expressions: SourceTypedExprV1[] = [
  symbol,
  slot,
  { kind: "local", parameter_id: "x" },
  { kind: "unary", operator: "not", operand: symbol },
  { kind: "binary", operator: ">", left: symbol, right: slot },
  { kind: "call", function_id: "registered", arguments: [symbol] },
  {
    kind: "conditional",
    condition: symbol,
    when_true: slot,
    when_false: symbol,
  },
  { kind: "list", items: [symbol] },
  { kind: "tuple", items: [slot] },
  { kind: "dict", entries: [{ key: slot, value: symbol }] },
  { kind: "index", collection: symbol, index: slot },
  {
    kind: "lambda",
    parameters: [{ kind: "local", parameter_id: "x" }],
    body: { kind: "local", parameter_id: "x" },
  },
]
const span = {
  scenario_id: "scenario",
  block_id: "block",
  path: "params.expr",
  start: 0,
  end: 0,
  sequence: 0,
}
const projection = () => ({
  dto_version: "1.0.0",
  source_hash: hash,
  edits: expressions.map((expression) => ({
    kind: "guard",
    expected_source_hash: hash,
    target: span,
    expression,
  })),
  diagnostics: [],
  publishable: false,
})

test("прикреплена точная frozen JSON schema T1 1.0.0", () => {
  expect(createHash("sha256").update(schemaBytes).digest("hex")).toBe(
    "3663bf745ce652668dfb14e7c496a8688b7ee7ca1a307c52a8551d8583febc18",
  )
})

test("все 12 безопасных AST tags проходят strict TS и canonical JSON schema", () => {
  const input = projection()
  expect(sourceLogicProjectionV1Schema.parse(input)).toEqual(input)
  expect(canonical.safeParse(input).success).toBe(true)
  expect(parseSourceLogicProjectionV1(input)).toEqual(input)
})

test("assignment и transition сохраняют exact port/span и terminal null", () => {
  const input = {
    ...projection(),
    edits: [
      {
        kind: "assignment",
        expected_source_hash: hash,
        target: span,
        symbol_id: "symbol",
        mode: "+",
        operands: [symbol, slot],
      },
      {
        kind: "transition",
        expected_source_hash: hash,
        target: span,
        port: {
          scenario_id: "scenario",
          block_id: "block",
          source_path: "params.expr",
          name: null,
          target_block_id: "target",
          sequence: 0,
        },
        target_block_id: null,
      },
    ],
  }
  expect(canonical.safeParse(input).success).toBe(true)
  expect(sourceLogicProjectionV1Schema.parse(input)).toEqual(input)
})

test.each([
  "value",
  "value_ref",
  "payload_ref",
  "credential_ref",
  "default",
])("AST не принимает protected field %s", (field) => {
  const expr = { ...slot, [field]: "synthetic-secret" }
  expect(sourceTypedExprV1Schema.safeParse(expr).success).toBe(false)
  expect(
    canonical.safeParse({
      ...projection(),
      edits: [
        {
          kind: "guard",
          expected_source_hash: hash,
          target: span,
          expression: expr,
        },
      ],
    }).success,
  ).toBe(false)
})

test("unknown operators/functions shape отклоняются без выполнения", () => {
  expect(
    sourceTypedExprV1Schema.safeParse({
      kind: "binary",
      operator: "eval",
      left: symbol,
      right: slot,
    }).success,
  ).toBe(false)
  expect(
    sourceTypedExprV1Schema.safeParse({
      kind: "call",
      function_id: "eval(code)",
      arguments: [],
    }).success,
  ).toBe(false)
})

test("циклическое и слишком глубокое дерево завершается безопасной ошибкой", () => {
  const cyclic: Record<string, unknown> = { kind: "list" }
  cyclic.items = [cyclic]
  expect(() =>
    parseSourceLogicProjectionV1({
      ...projection(),
      edits: [
        {
          kind: "guard",
          expected_source_hash: hash,
          target: span,
          expression: cyclic,
        },
      ],
    }),
  ).toThrow("Циклическое")
  let expression: unknown = symbol
  for (let i = 0; i < 300; i++) {
    expression = { kind: "unary", operator: "not", operand: expression }
  }
  expect(() =>
    parseSourceLogicProjectionV1({
      ...projection(),
      edits: [
        { kind: "guard", expected_source_hash: hash, target: span, expression },
      ],
    }),
  ).toThrow("Лимит сложности")
})

test("слоты в dict/lambda/collections остаются handles и не раскрывают значения", () => {
  const input = sourceLogicProjectionV1Schema.parse(projection())
  expect(collectSourceLiteralSlotsV1(input)).toEqual([slot])
  expect(JSON.stringify(collectSourceLiteralSlotsV1(input))).not.toContain(
    "value",
  )
})
