import { z } from "zod"

export const supacrmOperatorSchema = z.strictObject({
  reason: z.string().trim().min(1).max(160),
  queue: z.string().trim().min(1).max(80),
  assigneeId: z.number().int().positive().nullable(),
  stage: z.enum(["onboarding", "fulfillment", "support"]),
  includeCurrentOrder: z.boolean(),
  dataKeys: z.array(z.string().trim().min(1).max(80)).max(20),
  message: z.string().trim().min(1).max(500),
})
export type SupacrmOperator = z.infer<typeof supacrmOperatorSchema>
export const supacrmOperatorCommand = (input: unknown): string =>
  `SUPACRM_ACTION_V1:${JSON.stringify({ action: "operator.request", payload: supacrmOperatorSchema.parse(input) })}`
export const getSupacrmOperator = (
  details: unknown,
): SupacrmOperator | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmOperator" in details)
  ) {
    return null
  }
  const result = supacrmOperatorSchema.safeParse(details.supacrmOperator)
  return result.success ? result.data : null
}
export const refineSupacrmOperator = (
  details: {
    supacrmOperator?: SupacrmOperator
    supacrmDataRequest?: unknown
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
  if (!details.supacrmOperator) {
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
    details.supacrmDataRequest ||
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
    step.text !== supacrmOperatorCommand(details.supacrmOperator) ||
    step.buttons?.length !== 0 ||
    ports.length !== 2 ||
    new Set(ports.map((p) => p.id)).size !== 2 ||
    ports.some(
      (p) =>
        p.buttonType !== null || p.beforeStep !== null || p.steps?.length !== 0,
    ) ||
    details.quickReplySettings?.followUp.enabled ||
    details.quickReplySettings?.retry.enabled
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmOperator"],
      message: "supacrmOperatorInvalid",
    })
  }
}
