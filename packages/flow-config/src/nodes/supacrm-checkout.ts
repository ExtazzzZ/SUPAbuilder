import {
  checkoutPorts,
  getSupacrmCheckout,
  type SupacrmCheckout,
  supacrmCheckoutCommand,
  supacrmCheckoutSchema,
} from "../extensions/supacrm-checkout"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmCheckout = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmCheckoutSchema.parse(input)
  const previous = getSupacrmCheckout(node.data.details)
  if (previous && previous.kind !== settings.kind) {
    throw new Error("Checkout kind cannot change")
  }
  if (
    node.data.details.supacrmForm ||
    node.data.details.supacrmProduct ||
    node.data.details.supacrmVariable
  ) {
    throw new Error("Checkout requires its own node")
  }
  const step = sendTextStepDefaultFn({ text: supacrmCheckoutCommand(settings) })
  if (previous && node.data.details.steps[0]?.stepType === "sendText") {
    step.id = node.data.details.steps[0].id
  }
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        supacrmCheckout: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: previous
          ? node.data.details.quickReplies
          : checkoutPorts[settings.kind].map((label) =>
              buttonStepDefaultFn({ label }),
            ),
      },
    },
  }
}
export const createSupacrmCheckoutNode = (
  props: DefaultNodeProps,
  kind: SupacrmCheckout["kind"],
  settings?: SupacrmCheckout,
): SendMessageNodeSchema =>
  configureSupacrmCheckout(
    sendMessageNodeDefaultFn(props),
    settings ?? {
      kind,
      prompt: "Продолжите оформление заказа.",
      cancelLabel: kind === "wait" ? "Отменить ожидание" : "Назад",
      ...(kind === "wait" ? { timeoutSeconds: 900 } : {}),
      ...(kind === "promo" || kind === "bonus" ? { skipLabel: "Без льготы" } : {}),
      ...(kind === "bonus" ? { confirmLabel: "Применить бонусы" } : {}),
      ...(kind === "referral_summary" ? { continueLabel: "Продолжить" } : {}),
    },
  )
