import { z } from "zod"
import { flowValidationCodes } from "../validation-codes"

const presentation = {
  prompt: z.string().trim().min(1).max(500),
  cancelLabel: z.string().trim().min(1).max(40),
}
const choiceLabel = z.string().trim().min(1).max(40)
export const supacrmCheckoutSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("promo"), ...presentation, skipLabel: choiceLabel }),
  z.strictObject({ kind: z.literal("bonus"), ...presentation, skipLabel: choiceLabel, confirmLabel: choiceLabel }),
  z.strictObject({ kind: z.literal("referral_summary"), ...presentation, continueLabel: choiceLabel }),
  z.strictObject({ kind: z.literal("offer"), ...presentation }),
  z.strictObject({ kind: z.literal("receipt"), ...presentation }),
  z.strictObject({ kind: z.literal("link"), ...presentation }),
  z.strictObject({
    kind: z.literal("wait"),
    ...presentation,
    timeoutSeconds: z.number().int().min(30).max(86_400),
  }),
])
export type SupacrmCheckout = z.infer<typeof supacrmCheckoutSchema>
export const checkoutPorts = {
  promo: ["applied", "skipped", "refused", "cancelled", "review"],
  bonus: ["applied", "skipped", "refused", "cancelled", "review"],
  referral_summary: ["continued", "cancelled", "review"],
  offer: ["confirmed", "cancelled", "stale", "review"],
  receipt: ["email_required", "skipped", "cancelled"],
  link: ["ready", "known_failure", "unknown", "cancelled", "stale", "review"],
  wait: ["paid", "cancelled", "review"],
} as const
export const supacrmCheckoutCommand = (input: unknown): string => {
  const payload = supacrmCheckoutSchema.parse(input)
  return `SUPACRM_ACTION_V1:${JSON.stringify({ action: `checkout.${payload.kind}`, payload })}`
}
export const getSupacrmCheckout = (
  details: unknown,
): SupacrmCheckout | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmCheckout" in details)
  ) {
    return null
  }
  const result = supacrmCheckoutSchema.safeParse(details.supacrmCheckout)
  return result.success ? result.data : null
}
export const refineSupacrmCheckout = (
  details: {
    supacrmCheckout?: SupacrmCheckout
    supacrmForm?: unknown
    supacrmProduct?: unknown
    supacrmVariable?: unknown
    beforeStep: { channel: string }
    steps: unknown[]
    quickReplies: unknown[]
  },
  ctx: z.RefinementCtx,
): void => {
  const settings = details.supacrmCheckout
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
    details.supacrmForm ||
    details.supacrmProduct ||
    details.supacrmVariable ||
    details.beforeStep.channel !== "api" ||
    details.steps.length !== 1 ||
    step?.stepType !== "sendText" ||
    step.text !== supacrmCheckoutCommand(settings) ||
    step.buttons?.length !== 0 ||
    ports.length !== checkoutPorts[settings.kind].length ||
    new Set(ports.map((p) => p.id)).size !== ports.length ||
    ports.some(
      (p) =>
        p.buttonType !== null || p.beforeStep !== null || p.steps?.length !== 0,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmCheckout"],
      message: flowValidationCodes.supacrmCheckoutInvalid,
    })
  }
}
