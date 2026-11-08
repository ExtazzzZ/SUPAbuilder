import { z } from "zod"
import { flowValidationCodes } from "../validation-codes"

const text = z.string().trim().min(1).max(500)
const label = z.string().trim().min(1).max(40)

/** Только почта для чека CRM; значения клиента не являются настройками графа. */
export const supacrmFormSchema = z.strictObject({
  kind: z.literal("receiptEmail"),
  prompt: text,
  invalidMessage: text,
  confirmationPrompt: text.refine((value) => value.includes("{email}")),
  confirmLabel: label,
  editLabel: label,
  cancelLabel: label,
  useSavedEmail: z.boolean(),
  validator: z.literal("crmReceiptEmail"),
})
export type SupacrmForm = z.infer<typeof supacrmFormSchema>

export const areSupacrmNativeOutputs = (outputs: unknown[]): boolean =>
  outputs.length === 2 &&
  outputs.every((output) => {
    if (!output || typeof output !== "object") {
      return false
    }
    return (
      "buttonType" in output &&
      output.buttonType === null &&
      "beforeStep" in output &&
      output.beforeStep === null &&
      "steps" in output &&
      Array.isArray(output.steps) &&
      output.steps.length === 0
    )
  }) &&
  (outputs[0] as { id: string }).id !== (outputs[1] as { id: string }).id

export const supacrmFormCommand = (settings: unknown): string =>
  `SUPACRM_ACTION_V1:${JSON.stringify({ action: "form.receipt_email", payload: supacrmFormSchema.parse(settings) })}`

export const getSupacrmForm = (details: unknown): SupacrmForm | null => {
  if (!details || typeof details !== "object" || !("supacrmForm" in details)) {
    return null
  }
  const result = supacrmFormSchema.safeParse(details.supacrmForm)
  return result.success ? result.data : null
}

export const refineSupacrmForm = (
  details: {
    supacrmForm?: SupacrmForm
    supacrmProduct?: unknown
    supacrmVariable?: unknown
    beforeStep: { channel: string }
    steps: unknown[]
    quickReplies: unknown[]
  },
  ctx: z.RefinementCtx,
): void => {
  if (!details.supacrmForm) {
    return
  }
  const step = details.steps[0] as
    | { stepType?: string; text?: string; buttons?: unknown[] }
    | undefined
  if (
    details.supacrmProduct ||
    details.supacrmVariable ||
    details.beforeStep.channel !== "api" ||
    details.steps.length !== 1 ||
    step?.stepType !== "sendText" ||
    step.text !== supacrmFormCommand(details.supacrmForm) ||
    step.buttons?.length !== 0 ||
    !areSupacrmNativeOutputs(details.quickReplies)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmForm"],
      message: flowValidationCodes.supacrmFormInvalid,
    })
  }
}
