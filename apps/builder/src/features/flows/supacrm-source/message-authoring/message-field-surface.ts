import { sourceSpanV1Schema } from "@chatbotx.io/flow-config"
import { z } from "zod"

/** Full IR fingerprint и raw source hash — отдельные серверные SHA-256 pins. */
export const messageFieldHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const messageSurfaceFieldSchema = z
  .strictObject({
    field_id: z.string(),
    target: sourceSpanV1Schema,
    editable: z.boolean(),
    code: z.string(),
    handler_id: z.string().optional(),
    policy_revision: z.string().optional(),
    descriptor_version: z.string().optional(),
    schema_ref: z.string().optional(),
  })
  .superRefine((field, context) => {
    const pins = [
      field.handler_id,
      field.policy_revision,
      field.descriptor_version,
      field.schema_ref,
    ]
    const registered = pins.every(
      (pin) => typeof pin === "string" && pin.length > 0,
    )
    if (
      (field.editable || pins.some((pin) => pin !== undefined)) &&
      !registered
    ) {
      context.addIssue({
        code: "custom",
        message: "message_descriptor_pins_incomplete",
      })
    }
  })

/** E1 inventory не раскрывает текст, payload, evidence и значения символов. */
export const messageFieldSurfaceSchema = z
  .strictObject({
    schema_version: z.literal("source-authoring-surface/1"),
    source_revision: messageFieldHashSchema,
    source_hash: messageFieldHashSchema,
    draft_version: z.number().int().nonnegative(),
    fields: z.array(messageSurfaceFieldSchema),
    unsupported_field_ids: z.array(z.string()),
    production: z.literal(false),
    publishable: z.literal(false),
  })
  .superRefine((surface, context) => {
    const fields = new Set(surface.fields.map((field) => field.field_id))
    const unsupported = new Set(surface.unsupported_field_ids)
    const expected = surface.fields.filter((field) => !field.editable)
    if (
      fields.size !== surface.fields.length ||
      unsupported.size !== surface.unsupported_field_ids.length ||
      unsupported.size !== expected.length ||
      expected.some((field) => !unsupported.has(field.field_id))
    ) {
      context.addIssue({
        code: "custom",
        message: "message_surface_scope_incoherent",
      })
    }
  })
export type MessageFieldSurface = z.infer<typeof messageFieldSurfaceSchema>
