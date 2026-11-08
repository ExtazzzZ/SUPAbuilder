import { z } from "zod"
import { supacrmFormSchema } from "./supacrm-form"

const id = z.string().regex(/^\d+$/)
export const receiptEmailTemplateSourceSchema = z.strictObject({
  kind: z.literal("receiptEmail"),
  flowId: id,
  flowVersionId: id,
  nodeId: id,
})
export const receiptEmailOverridesSchema = z.strictObject({
  prompt: supacrmFormSchema.shape.prompt.optional(),
})
export const receiptEmailTemplateSchema = z.strictObject({
  source: receiptEmailTemplateSourceSchema,
  snapshot: supacrmFormSchema,
  overrides: receiptEmailOverridesSchema,
})
export type ReceiptEmailTemplate = z.infer<typeof receiptEmailTemplateSchema>
export type ReceiptEmailTemplateSource = z.infer<
  typeof receiptEmailTemplateSourceSchema
>

/** Opaque, lossless metadata copied from an acknowledged draft, including malformed drafts that need repair. */
export const receiptEmailTemplateBaseSchema = z.array(
  z.strictObject({
    nodeId: z.string(),
    template: z.unknown(),
  }),
)
export type ReceiptEmailTemplateBase = z.infer<
  typeof receiptEmailTemplateBaseSchema
>
export function getReceiptEmailTemplateBase(
  nodes: readonly unknown[],
): ReceiptEmailTemplateBase {
  return nodes
    .flatMap((value) => {
      const node = value as {
        id?: unknown
        data?: { details?: { supacrmFormTemplate?: unknown } }
      } | null
      const template = node?.data?.details?.supacrmFormTemplate
      return template === undefined || typeof node?.id !== "string"
        ? []
        : [{ nodeId: node.id, template }]
    })
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

export const effectiveReceiptEmailSettings = (input: ReceiptEmailTemplate) =>
  supacrmFormSchema.parse({
    ...input.snapshot,
    ...(input.overrides.prompt === undefined
      ? {}
      : { prompt: input.overrides.prompt }),
  })

/** JSON content comparison ignores object key order and editor-only selection state. */
export function receiptEmailContentKey(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(canonical)
    }
    if (!item || typeof item !== "object") {
      return item
    }
    return Object.fromEntries(
      Object.entries(item)
        .filter(
          ([key, child]) =>
            child !== undefined &&
            ![
              "selected",
              "dragging",
              "width",
              "height",
              "forceToolbarVisible",
            ].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    )
  }
  return JSON.stringify(canonical(value))
}

export function refineReceiptEmailTemplate(
  details: {
    supacrmFormTemplate?: ReceiptEmailTemplate
    supacrmForm?: z.infer<typeof supacrmFormSchema>
  },
  ctx: z.RefinementCtx,
): void {
  if (!details.supacrmFormTemplate) {
    return
  }
  const parsed = receiptEmailTemplateSchema.safeParse(
    details.supacrmFormTemplate,
  )
  if (!parsed.success) {
    return
  }
  if (
    receiptEmailContentKey(details.supacrmForm) !==
    receiptEmailContentKey(effectiveReceiptEmailSettings(parsed.data))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmFormTemplate"],
      message: "receiptEmailTemplateSettingsMismatch",
    })
  }
}
