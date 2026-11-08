import {
  type SourceTypedExprV1,
  sourceBinaryOperatorsV1,
  sourceLiteralTypesV1,
  sourcePortV1Schema,
  sourceSpanV1Schema,
  sourceUnaryOperatorsV1,
} from "@chatbotx.io/flow-config"
import { z } from "zod"

const identifier = z.string().min(1)
const localIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const localParameterSchema = z.strictObject({
  kind: z.literal("local").default("local"),
  parameter_id: localIdentifier,
})
const literalSlotSchema = z.strictObject({
  kind: z.literal("literal_slot").default("literal_slot"),
  slot_id: identifier,
  declared_type: z.enum(sourceLiteralTypesV1),
})

/** Frozen TypedExpr: kind обязателен в discriminator, но direct LocalExpr параметра имеет default. */
const switchTypedExprSchema: z.ZodType<SourceTypedExprV1> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("symbol"), symbol_id: identifier }),
    z.strictObject({
      kind: z.literal("literal_slot"),
      slot_id: identifier,
      declared_type: z.enum(sourceLiteralTypesV1),
    }),
    z.strictObject({ kind: z.literal("local"), parameter_id: localIdentifier }),
    z.strictObject({
      kind: z.literal("unary"),
      operator: z.enum(sourceUnaryOperatorsV1),
      operand: switchTypedExprSchema,
    }),
    z.strictObject({
      kind: z.literal("binary"),
      operator: z.enum(sourceBinaryOperatorsV1),
      left: switchTypedExprSchema,
      right: switchTypedExprSchema,
    }),
    z.strictObject({
      kind: z.literal("call"),
      function_id: localIdentifier,
      arguments: z.array(switchTypedExprSchema),
    }),
    z.strictObject({
      kind: z.literal("conditional"),
      condition: switchTypedExprSchema,
      when_true: switchTypedExprSchema,
      when_false: switchTypedExprSchema,
    }),
    z.strictObject({
      kind: z.enum(["list", "tuple"]),
      items: z.array(switchTypedExprSchema),
    }),
    z.strictObject({
      kind: z.literal("dict"),
      entries: z.array(
        z.strictObject({
          key: switchTypedExprSchema,
          value: switchTypedExprSchema,
        }),
      ),
    }),
    z.strictObject({
      kind: z.literal("index"),
      collection: switchTypedExprSchema,
      index: switchTypedExprSchema,
    }),
    z.strictObject({
      kind: z.literal("lambda"),
      parameters: z.array(localParameterSchema),
      body: switchTypedExprSchema,
    }),
  ]),
)

const descriptorPins = {
  target: sourceSpanV1Schema,
  case_port: sourcePortV1Schema,
  handler_id: z.string(),
  policy_revision: z.string(),
  descriptor_version: z.string(),
  schema_ref: z.string(),
}
const editScope = {
  field_id: identifier,
  case_id: identifier,
  ...descriptorPins,
  expected_full_ir_id: z.string(),
  expected_source_hash: z.string(),
  expected_draft_version: z.number().int().nonnegative(),
}
const text = z.string().refine((value) => Array.from(value).length <= 16_384)

/** Только RIGHT operand существующего case; профиль, порядок, default и authority проверяет сервер. */
export const switchFieldEditSchema = z.strictObject({
  ...editScope,
  schema_version: z
    .literal("switch-field-edit/1")
    .default("switch-field-edit/1"),
  expression: switchTypedExprSchema,
})
export const switchLiteralWriteSchema = z.strictObject({
  ...editScope,
  schema_version: z
    .literal("switch-field-slot/1")
    .default("switch-field-slot/1"),
  text,
})
export const switchLiteralViewSchema = z.strictObject({
  schema_version: z
    .literal("switch-field-view/1")
    .default("switch-field-view/1"),
  field_id: z.string(),
  case_id: z.string(),
  ...descriptorPins,
  source_revision: z.string(),
  source_hash: z.string(),
  draft_version: z.number().int().nonnegative(),
  slot: literalSlotSchema,
  text,
})

/** Публичная модель owner descriptor, без server-only switch bindings и predicate/profile refs. */
export const registeredOwnerDescriptorSchema = z.strictObject({
  field_id: z.string(),
  source_kind: z.string(),
  span: sourceSpanV1Schema,
  category: z.enum([
    "template",
    "action",
    "input",
    "timer",
    "connector",
    "trigger",
  ]),
  owner: identifier,
  edit_kind: z.enum(["template", "expression", "owner_secure"]),
  handler_id: identifier,
  policy_revision: identifier,
  full_ir_id: z.string(),
  descriptor_version: z.string(),
  schema_ref: identifier,
  evidence_refs: z.array(z.string()).min(1),
  sensitivity: z.enum(["ordinary", "protected", "secret", "unresolved"]),
  protected: z.boolean(),
  value_mode: z.enum(["ordinary_slot", "owner_secure"]),
})

export type SwitchFieldEdit = z.infer<typeof switchFieldEditSchema>
export type SwitchLiteralWrite = z.infer<typeof switchLiteralWriteSchema>
export type SwitchLiteralView = z.infer<typeof switchLiteralViewSchema>
export type RegisteredOwnerDescriptor = z.infer<
  typeof registeredOwnerDescriptorSchema
>
