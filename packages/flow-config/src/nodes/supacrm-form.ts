import {
  getSupacrmForm,
  type SupacrmForm,
  supacrmFormCommand,
  supacrmFormSchema,
} from "../extensions/supacrm-form"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmEmail = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmFormSchema.parse(input)
  const old = getSupacrmForm(node.data.details)
  const previous = node.data.details.steps[0]
  const step = sendTextStepDefaultFn({ text: supacrmFormCommand(settings) })
  if (old && previous?.stepType === "sendText") {
    step.id = previous.id
  }
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        supacrmForm: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: old
          ? node.data.details.quickReplies
          : [
              buttonStepDefaultFn({ label: settings.confirmLabel }),
              buttonStepDefaultFn({ label: settings.cancelLabel }),
            ],
      },
    },
  }
}

export const createSupacrmEmailNode = (
  props: DefaultNodeProps,
  settings?: SupacrmForm,
): SendMessageNodeSchema =>
  configureSupacrmEmail(
    sendMessageNodeDefaultFn(props),
    settings ?? {
      kind: "receiptEmail",
      prompt: "Напишите электронную почту для чека.",
      invalidMessage: "Напишите только email без других слов.",
      confirmationPrompt: "Ваша почта {email}. Всё верно?",
      confirmLabel: "Подтвердить",
      editLabel: "Исправить",
      cancelLabel: "Назад",
      useSavedEmail: true,
      validator: "crmReceiptEmail",
    },
  )
