import { z } from "zod"

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in author text.
const forbiddenInstruction = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f{}]/u
const unpairedSurrogate = /[\uD800-\uDFFF]/u
const prefix = "SUPACRM_ACTION_V1:"
const encode = (payload: { kind: string }): string =>
  `${prefix}${JSON.stringify({ action: `fulfillment.${payload.kind}`, payload })}`
const instruction = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (text) =>
      text.length <= 2000 &&
      !forbiddenInstruction.test(text) &&
      !unpairedSurrogate.test(
        Array.from(text)
          .filter((c) => c.length === 1)
          .join(""),
      ),
    "fulfillment_instruction_invalid",
  )
export const supacrmFulfillmentSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("execute"),
      strategy: z.literal("apple_code_us_v1"),
    }),
    z.strictObject({
      kind: z.literal("issue"),
      plan: z.strictObject({
        kind: z.literal("apple_us_delivery_v1"),
        requiredParts: z.tuple([
          z.strictObject({
            key: z.literal("author_instruction"),
            kind: z.literal("plain_instruction"),
            required: z.literal(true),
            text: instruction,
          }),
          z.strictObject({
            key: z.literal("apple_code_reference"),
            kind: z.literal("provider_apple_reference"),
            required: z.literal(true),
          }),
        ]),
      }),
    }),
  ])
  .refine(
    (value) => Array.from(encode(value)).length <= 4000,
    "fulfillment_command_too_large",
  )
export type SupacrmFulfillment = z.infer<typeof supacrmFulfillmentSchema>
export const fulfillmentPorts = {
  execute: ["completed", "unknown", "review"],
  issue: ["sent", "unknown", "review"],
} as const
export const supacrmFulfillmentCommand = (input: unknown): string =>
  encode(supacrmFulfillmentSchema.parse(input))
export const parseSupacrmFulfillmentCommand = (
  text: unknown,
): SupacrmFulfillment | null => {
  if (
    typeof text !== "string" ||
    !text.startsWith(prefix) ||
    Array.from(text).length > 4000
  ) {
    return null
  }
  try {
    const envelope = z
      .strictObject({
        action: z.enum(["fulfillment.execute", "fulfillment.issue"]),
        payload: supacrmFulfillmentSchema,
      })
      .parse(JSON.parse(text.slice(prefix.length)))
    return envelope.action === `fulfillment.${envelope.payload.kind}`
      ? envelope.payload
      : null
  } catch {
    return null
  }
}
export const getSupacrmFulfillment = (
  details: unknown,
): SupacrmFulfillment | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmFulfillment" in details)
  ) {
    return null
  }
  const result = supacrmFulfillmentSchema.safeParse(details.supacrmFulfillment)
  return result.success ? result.data : null
}
export const refineSupacrmFulfillment = (
  details: {
    supacrmFulfillment?: SupacrmFulfillment
    supacrmCheckout?: unknown
    supacrmForm?: unknown
    supacrmProduct?: unknown
    supacrmVariable?: unknown
    supacrmFormTemplate?: unknown
    beforeStep: { channel: string }
    steps: unknown[]
    quickReplies: unknown[]
    quickReplySettings?: {
      followUp: { enabled: boolean }
      retry: { enabled: boolean }
    }
  },
  ctx: z.RefinementCtx,
): void => {
  const settings = details.supacrmFulfillment
  if (!settings) {
    return
  }
  const step = details.steps[0] as
    | { stepType?: string; text?: string; buttons?: unknown[] }
    | undefined
  const ports = details.quickReplies as {
    id: string
    buttonType?: string | null
    beforeStep?: unknown
    steps?: unknown[]
  }[]
  if (
    details.supacrmCheckout ||
    details.supacrmForm ||
    details.supacrmProduct ||
    details.supacrmVariable ||
    details.supacrmFormTemplate ||
    details.quickReplySettings?.followUp.enabled ||
    details.quickReplySettings?.retry.enabled ||
    details.beforeStep.channel !== "api" ||
    details.steps.length !== 1 ||
    step?.stepType !== "sendText" ||
    step.text !== encode(settings) ||
    step.buttons?.length !== 0 ||
    ports.length !== 3 ||
    new Set(ports.map((p) => p.id)).size !== 3 ||
    ports.some(
      (p) =>
        p.buttonType !== null || p.beforeStep !== null || p.steps?.length !== 0,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmFulfillment"],
      message: "supacrmFulfillmentInvalid",
    })
  }
}
