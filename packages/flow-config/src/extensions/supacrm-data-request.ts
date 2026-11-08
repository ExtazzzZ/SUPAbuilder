import { z } from "zod"

export const supacrmDataRequestSchema = z.strictObject({
  valueType: z.enum(["email", "number", "text", "phone"]),
  variableKey: z
    .string()
    .trim()
    .regex(/^input\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  prompt: z.string().trim().min(1).max(500),
  invalidMessage: z.string().trim().min(1).max(500),
  maxAttempts: z.number().int().min(1).max(10),
  timeoutSeconds: z.number().int().min(30).max(86_400),
  confirmation: z.boolean(),
  confirmationPrompt: z.string().trim().min(1).max(500),
  confirmLabel: z.string().trim().min(1).max(40),
  editLabel: z.string().trim().min(1).max(40),
  cancelLabel: z.string().trim().min(1).max(40),
})
export type SupacrmDataRequest = z.infer<typeof supacrmDataRequestSchema>
export const supacrmDataRequestCommand = (input: unknown): string =>
  `SUPACRM_ACTION_V1:${JSON.stringify({ action: "input.request", payload: supacrmDataRequestSchema.parse(input) })}`
export const getSupacrmDataRequest = (
  details: unknown,
): SupacrmDataRequest | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmDataRequest" in details)
  ) {
    return null
  }
  const result = supacrmDataRequestSchema.safeParse(details.supacrmDataRequest)
  return result.success ? result.data : null
}
export const refineSupacrmDataRequest = (
  details: {
    supacrmDataRequest?: SupacrmDataRequest
    supacrmOperator?: unknown
    supacrmReminder?: unknown
    supacrmCheckout?: unknown
    supacrmFulfillment?: unknown
    supacrmProduct?: unknown
    supacrmForm?: unknown
    supacrmFormTemplate?: unknown
    supacrmVariable?: unknown
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
  if (!details.supacrmDataRequest) {
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
    details.supacrmOperator ||
    details.supacrmReminder ||
    details.supacrmCheckout ||
    details.supacrmFulfillment ||
    details.supacrmProduct ||
    details.supacrmForm ||
    details.supacrmFormTemplate ||
    details.supacrmVariable ||
    details.beforeStep.channel !== "api" ||
    details.steps.length !== 1 ||
    step?.stepType !== "sendText" ||
    step.text !== supacrmDataRequestCommand(details.supacrmDataRequest) ||
    step.buttons?.length !== 0 ||
    ports.length !== 3 ||
    new Set(ports.map((p) => p.id)).size !== 3 ||
    ports.some(
      (p) =>
        p.buttonType !== null || p.beforeStep !== null || p.steps?.length !== 0,
    ) ||
    details.quickReplySettings?.followUp.enabled ||
    details.quickReplySettings?.retry.enabled
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmDataRequest"],
      message: "supacrmDataRequestInvalid",
    })
  }
}
