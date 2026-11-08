import { z } from "zod"

export const supacrmReminderSchema = z.strictObject({
  anchor: z.enum([
    "order_created",
    "link_issued",
    "paid",
    "delivered",
    "customer_confirmed",
  ]),
  delaySeconds: z.number().int().min(0).max(2_592_000),
  action: z.enum(["message", "continue"]),
  message: z.string().trim().min(1).max(1000),
  cancelOnPaid: z.boolean(),
  cancelOnReply: z.boolean(),
  cancelOnOrderCancelled: z.boolean(),
})
export type SupacrmReminder = z.infer<typeof supacrmReminderSchema>
export const supacrmReminderCommand = (input: unknown): string =>
  `SUPACRM_ACTION_V1:${JSON.stringify({ action: "reminder.schedule", payload: supacrmReminderSchema.parse(input) })}`
export const getSupacrmReminder = (
  details: unknown,
): SupacrmReminder | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmReminder" in details)
  ) {
    return null
  }
  const result = supacrmReminderSchema.safeParse(details.supacrmReminder)
  return result.success ? result.data : null
}
export const refineSupacrmReminder = (
  details: {
    supacrmReminder?: SupacrmReminder
    supacrmDataRequest?: unknown
    supacrmOperator?: unknown
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
  if (!details.supacrmReminder) {
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
    details.supacrmOperator ||
    details.supacrmCheckout ||
    details.supacrmFulfillment ||
    details.supacrmProduct ||
    details.supacrmForm ||
    details.supacrmFormTemplate ||
    details.supacrmVariable ||
    details.beforeStep.channel !== "api" ||
    details.steps.length !== 1 ||
    step?.stepType !== "sendText" ||
    step.text !== supacrmReminderCommand(details.supacrmReminder) ||
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
      path: ["supacrmReminder"],
      message: "supacrmReminderInvalid",
    })
  }
}
