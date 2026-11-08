// @vitest-environment node
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import {
  registeredOwnerDescriptorSchema,
  switchFieldEditSchema,
  switchLiteralViewSchema,
  switchLiteralWriteSchema,
} from "../src/features/flows/supacrm-source/switch-authoring/wire"

const raw = readFileSync(
  new URL(
    "../../../../v0/backend/app/modules/source_contract/switch_authoring_draft.schema.json",
    import.meta.url,
  ),
)
const bundle = JSON.parse(raw.toString())
const target = {
  scenario_id: "scenario",
  block_id: "switch",
  path: "params.cases.3.value",
  start: 0,
  end: 1,
  sequence: 3,
}
const casePort = {
  scenario_id: "scenario",
  block_id: "switch",
  source_path: "params.cases.3",
  name: "3",
  target_block_id: "next",
  sequence: 3,
}
const pins = {
  field_id: "field:case-value",
  case_id: "server-issued:opaque-case-id",
  target,
  case_port: casePort,
  handler_id: "source-switch/1",
  policy_revision: "policy1",
  descriptor_version: "descriptor1",
  schema_ref: "source.switch.case-value/1",
}
const cas = {
  expected_full_ir_id: "full-pin",
  expected_source_hash: "raw-hash",
  expected_draft_version: 7,
}
const slot = {
  kind: "literal_slot",
  slot_id: "ordinary-safe-slot",
  declared_type: "str",
}
const edit = { ...pins, ...cas, expression: slot }
const write = { ...pins, ...cas, text: "Новое значение" }
const view = {
  ...pins,
  source_revision: "full-pin",
  source_hash: "raw-hash",
  draft_version: 7,
  slot,
  text: "Обычный текст",
}
const descriptor = {
  field_id: "field:case-value",
  source_kind: "switch",
  span: target,
  category: "template",
  owner: "source.controls",
  edit_kind: "expression",
  handler_id: pins.handler_id,
  policy_revision: "policy1",
  full_ir_id: "full-pin",
  descriptor_version: "descriptor1",
  schema_ref: pins.schema_ref,
  evidence_refs: ["synthetic-consumer-proof"],
  sensitivity: "ordinary",
  protected: false,
  value_mode: "ordinary_slot",
}
const models = {
  SwitchFieldEdit: switchFieldEditSchema,
  SwitchLiteralWrite: switchLiteralWriteSchema,
  SwitchLiteralView: switchLiteralViewSchema,
  RegisteredOwnerDescriptor: registeredOwnerDescriptorSchema,
}
const fixtures = {
  SwitchFieldEdit: edit,
  SwitchLiteralWrite: write,
  SwitchLiteralView: view,
  RegisteredOwnerDescriptor: descriptor,
}
const symbol = { kind: "symbol", symbol_id: "symbol-id" }
const local = { kind: "local", parameter_id: "item" }

const expressions = [
  symbol,
  slot,
  local,
  { kind: "unary", operator: "not", operand: symbol },
  { kind: "binary", operator: "==", left: symbol, right: slot },
  {
    kind: "call",
    function_id: "safe_registered_function",
    arguments: [symbol, slot],
  },
  {
    kind: "conditional",
    condition: symbol,
    when_true: slot,
    when_false: local,
  },
  { kind: "list", items: [symbol, slot] },
  { kind: "tuple", items: [slot, local] },
  { kind: "dict", entries: [{ key: slot, value: symbol }] },
  { kind: "index", collection: symbol, index: slot },
  { kind: "lambda", parameters: [local], body: local },
]

test("schema hash и публичные модели точно соответствуют frozen T1 E2", () => {
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "9ce6802d3fa263271e305bc833723729afe29daadd7f6c9bb7ff29c5baa4f45f",
  )
  expect(Object.keys(models)).toEqual(bundle.public_models)
  expect(bundle.server_only_models).toEqual([
    "CompiledSwitchBinding",
    "CompiledSwitchCase",
  ])
  for (const [name, schema] of Object.entries(models)) {
    expect(Object.keys(schema.shape).sort()).toEqual(
      Object.keys(bundle.schemas[name].properties).sort(),
    )
    expect(bundle.schemas[name].additionalProperties).toBe(false)
  }
})

test("каждое обязательное поле frozen модели обязательно и для browser DTO", () => {
  for (const [name, schema] of Object.entries(models)) {
    const fixture = fixtures[name as keyof typeof fixtures]
    for (const key of bundle.schemas[name].required) {
      const candidate = { ...fixture, [key]: undefined }
      expect(schema.safeParse(candidate).success, `${name}.${key}`).toBe(false)
    }
  }
})

test("wire defaults сохраняют ABI, direct literal_slot и SourceSpan default fields", () => {
  expect(switchFieldEditSchema.parse(edit).schema_version).toBe(
    "switch-field-edit/1",
  )
  expect(switchLiteralWriteSchema.parse(write).schema_version).toBe(
    "switch-field-slot/1",
  )
  expect(
    switchLiteralViewSchema.parse({
      ...view,
      slot: { slot_id: slot.slot_id, declared_type: "str" },
      target: { scenario_id: "s", block_id: "b", path: "p" },
    }),
  ).toMatchObject({
    schema_version: "switch-field-view/1",
    slot: { ...slot },
    target: { start: 0, end: 0, sequence: 0 },
  })
  for (const [name, schema] of Object.entries(models)) {
    expect(
      schema.safeParse(fixtures[name as keyof typeof fixtures]).success,
    ).toBe(true)
  }
})

test.each(
  expressions,
)("RIGHT operand поддерживает frozen TypedExpr kind=$kind без вычисления", (expression) => {
  expect(
    switchFieldEditSchema.parse({ ...edit, expression }).expression,
  ).toEqual(expression)
})

test("nested lambda direct LocalExpr применяет defaultkind только к параметрам", () => {
  const expression = {
    kind: "call",
    function_id: "map",
    arguments: [
      {
        kind: "lambda",
        parameters: [{ parameter_id: "x" }],
        body: { kind: "local", parameter_id: "x" },
      },
    ],
  }
  expect(
    switchFieldEditSchema.parse({ ...edit, expression }).expression,
  ).toEqual({
    kind: "call",
    function_id: "map",
    arguments: [
      {
        kind: "lambda",
        parameters: [{ kind: "local", parameter_id: "x" }],
        body: { kind: "local", parameter_id: "x" },
      },
    ],
  })
  expect(
    switchFieldEditSchema.safeParse({
      ...edit,
      expression: { symbol_id: "symbol-id" },
    }).success,
  ).toBe(false)
})

test("operator и literal-type enums соответствуют определениям JSON Schema", () => {
  const defs = bundle.schemas.SwitchFieldEdit.$defs
  for (const operator of defs.UnaryExpr.properties.operator.enum) {
    expect(
      switchFieldEditSchema.safeParse({
        ...edit,
        expression: { kind: "unary", operator, operand: symbol },
      }).success,
    ).toBe(true)
  }
  for (const operator of defs.BinaryExpr.properties.operator.enum) {
    expect(
      switchFieldEditSchema.safeParse({
        ...edit,
        expression: { kind: "binary", operator, left: symbol, right: slot },
      }).success,
    ).toBe(true)
  }
  const types = defs.LiteralSlotExpr.properties.declared_type.anyOf.flatMap(
    (part: { enum?: string[]; const?: string }) => part.enum ?? [part.const],
  )
  for (const declared_type of types) {
    expect(
      switchFieldEditSchema.safeParse({
        ...edit,
        expression: { ...slot, declared_type },
      }).success,
    ).toBe(true)
    expect(
      switchLiteralViewSchema.safeParse({
        ...view,
        slot: { ...slot, declared_type },
      }).success,
    ).toBe(true)
  }
  for (const expression of [
    { kind: "unary", operator: "execute", operand: symbol },
    { kind: "binary", operator: "assign", left: symbol, right: slot },
    { ...slot, declared_type: "string" },
    { kind: "call", function_id: "unsafe()", arguments: [] },
    { kind: "local", parameter_id: "unsafe-name" },
  ]) {
    expect(
      switchFieldEditSchema.safeParse({ ...edit, expression }).success,
    ).toBe(false)
  }
})

test.each([
  "predicate_ref",
  "payload_ref",
  "source_profile_id",
  "source_profile_evidence_ref",
  "comparison_policy_ref",
  "global_input_policy_ref",
  "CompiledSwitchBinding",
  "CompiledSwitchCase",
  "cases",
  "default",
  "left",
  "comparison",
  "check_global_inputs",
])("публичные модели отвергают private/structural поле %s", (key) => {
  for (const [name, schema] of Object.entries(models)) {
    expect(
      schema.safeParse({
        ...fixtures[name as keyof typeof fixtures],
        [key]: "synthetic-private",
      }).success,
    ).toBe(false)
  }
  expect(
    switchFieldEditSchema.safeParse({
      ...edit,
      expression: { ...slot, [key]: "synthetic-private" },
    }).success,
  ).toBe(false)
  expect(
    switchLiteralViewSchema.safeParse({
      ...view,
      slot: { ...slot, [key]: "synthetic-private" },
    }).success,
  ).toBe(false)
})

test("полный predicate binding не является SwitchFieldEdit или safe view", () => {
  const compiled = {
    binding_version: "compiled-switch-field/1",
    source_revision: "full-pin",
    source_hash: "raw-hash",
    cases: [
      {
        case_id: pins.case_id,
        span: target,
        transition: casePort,
        predicate_ref: "private",
      },
    ],
    default: { ...casePort, name: "default" },
    source_profile_id: "private",
    comparison_policy_ref: "private",
  }
  expect(switchFieldEditSchema.safeParse(compiled).success).toBe(false)
  expect(switchLiteralViewSchema.safeParse(compiled).success).toBe(false)
})

test("case identity и provenance порта остаются непрозрачными и неизменными", () => {
  const parsed = switchFieldEditSchema.parse(edit)
  expect(parsed.case_id).toBe(pins.case_id)
  expect(parsed.case_port).toEqual(casePort)
  const nullable = {
    ...casePort,
    name: null,
    target_block_id: null,
    sequence: 9,
  }
  expect(
    switchFieldEditSchema.parse({ ...edit, case_port: nullable }).case_port,
  ).toEqual(nullable)
  for (const key of Object.keys(casePort)) {
    expect(
      switchFieldEditSchema.safeParse({
        ...edit,
        case_port: { ...casePort, [key]: undefined },
      }).success,
    ).toBe(false)
  }
  expect(
    switchFieldEditSchema.safeParse({
      ...edit,
      case_port: { ...casePort, predicate_ref: "private" },
    }).success,
  ).toBe(false)
  expect(
    switchFieldEditSchema.safeParse({
      ...edit,
      case_port: { ...casePort, sequence: -1 },
    }).success,
  ).toBe(false)
})

test("границы ID, draft и unicode text повторяют frozen public models", () => {
  for (const key of ["field_id", "case_id"]) {
    expect(
      switchFieldEditSchema.safeParse({ ...edit, [key]: "" }).success,
    ).toBe(false)
    expect(
      switchLiteralWriteSchema.safeParse({ ...write, [key]: "" }).success,
    ).toBe(false)
    expect(
      switchLiteralViewSchema.safeParse({ ...view, [key]: "" }).success,
    ).toBe(true)
  }
  for (const draft of [-1, 0.5]) {
    expect(
      switchFieldEditSchema.safeParse({
        ...edit,
        expected_draft_version: draft,
      }).success,
    ).toBe(false)
    expect(
      switchLiteralWriteSchema.safeParse({
        ...write,
        expected_draft_version: draft,
      }).success,
    ).toBe(false)
    expect(
      switchLiteralViewSchema.safeParse({ ...view, draft_version: draft })
        .success,
    ).toBe(false)
  }
  for (const text of ["", "😀".repeat(16_384)]) {
    expect(switchLiteralWriteSchema.safeParse({ ...write, text }).success).toBe(
      true,
    )
    expect(switchLiteralViewSchema.safeParse({ ...view, text }).success).toBe(
      true,
    )
  }
  for (const text of ["😀".repeat(16_385), 1, null]) {
    expect(switchLiteralWriteSchema.safeParse({ ...write, text }).success).toBe(
      false,
    )
    expect(switchLiteralViewSchema.safeParse({ ...view, text }).success).toBe(
      false,
    )
  }
})

test("все descriptor enums и minLength повторяют frozen constraints без разрешения редактирования", () => {
  const properties = bundle.schemas.RegisteredOwnerDescriptor.properties
  for (const [key, property] of Object.entries(properties)) {
    const rule = property as { enum?: string[]; minLength?: number }
    if (rule.enum) {
      for (const value of rule.enum) {
        expect(
          registeredOwnerDescriptorSchema.safeParse({
            ...descriptor,
            [key]: value,
          }).success,
        ).toBe(true)
      }
      expect(
        registeredOwnerDescriptorSchema.safeParse({
          ...descriptor,
          [key]: "unregistered-value",
        }).success,
      ).toBe(false)
    }
    if (rule.minLength === 1) {
      expect(
        registeredOwnerDescriptorSchema.safeParse({ ...descriptor, [key]: "" })
          .success,
      ).toBe(false)
    }
  }
  expect(
    registeredOwnerDescriptorSchema.safeParse({
      ...descriptor,
      evidence_refs: [],
    }).success,
  ).toBe(false)
  for (const schema_version of [
    "switch-field-edit/2",
    "message-field-edit/1",
    "",
  ]) {
    expect(
      switchFieldEditSchema.safeParse({ ...edit, schema_version }).success,
    ).toBe(false)
    expect(
      switchLiteralWriteSchema.safeParse({ ...write, schema_version }).success,
    ).toBe(false)
    expect(
      switchLiteralViewSchema.safeParse({ ...view, schema_version }).success,
    ).toBe(false)
  }
})

test.each([
  "reject",
  "ordered_first_match",
])("server-only duplicate_values_policy=%s не становится публичным UI-полем", (duplicate_values_policy) => {
  const policy =
    bundle.schemas.CompiledSwitchBinding.properties.duplicate_values_policy
  expect(policy.enum).toEqual(["reject", "ordered_first_match"])
  expect(policy.default).toBe("reject")
  for (const [name, schema] of Object.entries(models)) {
    expect(
      schema.safeParse({
        ...fixtures[name as keyof typeof fixtures],
        duplicate_values_policy,
      }).success,
    ).toBe(false)
  }
  expect(
    switchFieldEditSchema.safeParse({
      ...edit,
      expression: { ...slot, duplicate_values_policy },
    }).success,
  ).toBe(false)
})
