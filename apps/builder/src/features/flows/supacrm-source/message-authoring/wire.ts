import {
  sourceSpanV1Schema,
  sourceTypedExprV1Schema,
} from "@chatbotx.io/flow-config"
import { z } from "zod"

/** Публичный ABI message-field-edit/1; server-only artifacts здесь отсутствуют. */
export const messageLiteralSlotSchema = z.preprocess(
  (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !("kind" in value)
    ) {
      return { ...value, kind: "literal_slot" }
    }
    return value
  },
  sourceTypedExprV1Schema.transform((expression, context) => {
    if (expression.kind === "literal_slot") {
      return expression
    }
    context.addIssue({ code: "custom", message: "literal_slot_required" })
    return z.NEVER
  }),
)
const text = z.string().refine((value) => Array.from(value).length <= 16_384)
const descriptorPins = {
  field_id: z.string(),
  target: sourceSpanV1Schema,
  handler_id: z.string(),
  policy_revision: z.string(),
  descriptor_version: z.string(),
  schema_ref: z.string(),
}
const expectedPins = {
  expected_full_ir_id: z.string(),
  expected_source_hash: z.string(),
  expected_draft_version: z.number().int().nonnegative(),
}
export const plainTextTemplateSchema = z.strictObject({
  context: z.literal("text").default("text"),
  runs: z.array(messageLiteralSlotSchema).length(1),
})
export const messageFieldEditSchema = z.strictObject({
  ...descriptorPins,
  ...expectedPins,
  schema_version: z
    .literal("message-field-edit/1")
    .default("message-field-edit/1"),
  template: plainTextTemplateSchema,
})
export const messageLiteralWriteSchema = z.strictObject({
  ...descriptorPins,
  ...expectedPins,
  schema_version: z
    .literal("message-field-slot/1")
    .default("message-field-slot/1"),
  text,
})
export const messageLiteralViewSchema = z.strictObject({
  ...descriptorPins,
  schema_version: z
    .literal("message-field-view/1")
    .default("message-field-view/1"),
  source_revision: z.string(),
  source_hash: z.string(),
  draft_version: z.number().int().nonnegative(),
  slot: messageLiteralSlotSchema,
  text,
})
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
  owner: z.string().min(1),
  edit_kind: z.enum(["template", "expression", "owner_secure"]),
  handler_id: z.string().min(1),
  policy_revision: z.string().min(1),
  full_ir_id: z.string(),
  descriptor_version: z.string(),
  schema_ref: z.string().min(1),
  evidence_refs: z.array(z.string()).min(1),
  sensitivity: z.enum(["ordinary", "protected", "secret", "unresolved"]),
  protected: z.boolean(),
  value_mode: z.enum(["ordinary_slot", "owner_secure"]),
})
export type PlainTextTemplate = z.infer<typeof plainTextTemplateSchema>
export type MessageFieldEdit = z.infer<typeof messageFieldEditSchema>
export type MessageLiteralWrite = z.infer<typeof messageLiteralWriteSchema>
export type MessageLiteralView = z.infer<typeof messageLiteralViewSchema>
export type RegisteredOwnerDescriptor = z.infer<
  typeof registeredOwnerDescriptorSchema
>

/** Аддитивный T7 view request; raw hash поступает только из safe view response. */
export const messageLiteralViewRequestSchema = z.strictObject({
  schema_version: z
    .literal("message-field-view-request/1")
    .default("message-field-view-request/1"),
  field_id: z.string(),
  expected_full_ir_id: z.string(),
  expected_draft_version: z.number().int().nonnegative(),
})
export type MessageLiteralViewRequest = z.infer<
  typeof messageLiteralViewRequestSchema
>
