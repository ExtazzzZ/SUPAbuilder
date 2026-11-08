import { z } from "zod"
import { flowValidationCodes } from "../validation-codes"
import { areSupacrmNativeOutputs } from "./supacrm-form"

/** Ссылка на CRM; цена, тарифы, изображения и credentials в граф не копируются. */
export const supacrmProductSchema = z.strictObject({
  catalogItemId: z.string().max(36),
  selectTariff: z.literal(true).optional(),
})

export const supacrmProductCommand = (
  catalogItemId: string,
  selectTariff = false,
): string => {
  const id = z.uuid().parse(catalogItemId)
  return `SUPACRM_ACTION_V1:${JSON.stringify({ action: selectTariff ? "catalog.select_tariff" : "catalog.detail", payload: { item_id: id } })}`
}

export const getSupacrmProduct = (
  details: unknown,
): { catalogItemId: string; selectTariff?: true } | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmProduct" in details)
  ) {
    return null
  }
  const result = supacrmProductSchema.safeParse(details.supacrmProduct)
  return result.success ? result.data : null
}

/** Проверка пары metadata/runtime: API primitive исполняет выбранный товар, не иной текст. */
export const refineSupacrmProduct = (
  details: {
    supacrmProduct?: { catalogItemId: string; selectTariff?: true }
    beforeStep: { channel: string }
    steps: unknown[]
    quickReplies: unknown[]
  },
  ctx: z.RefinementCtx,
): void => {
  if (!details.supacrmProduct) {
    return
  }
  const id = z.uuid().safeParse(details.supacrmProduct.catalogItemId)
  if (!id.success) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmProduct", "catalogItemId"],
      message: flowValidationCodes.supacrmProductRequired,
    })
    return
  }
  const step = details.steps[0]
  if (
    details.beforeStep.channel !== "api" ||
    details.quickReplies.length !==
      (details.supacrmProduct.selectTariff ? 2 : 0) ||
    (details.supacrmProduct.selectTariff &&
      !areSupacrmNativeOutputs(details.quickReplies)) ||
    details.steps.length !== 1 ||
    !step ||
    typeof step !== "object" ||
    !("stepType" in step) ||
    step.stepType !== "sendText" ||
    !("text" in step) ||
    step.text !==
      supacrmProductCommand(id.data, details.supacrmProduct.selectTariff) ||
    !("buttons" in step) ||
    !Array.isArray(step.buttons) ||
    step.buttons.length !== 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmProduct"],
      message: flowValidationCodes.supacrmProductInvalid,
    })
  }
}
