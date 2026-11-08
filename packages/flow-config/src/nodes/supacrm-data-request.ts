import {
  getSupacrmDataRequest,
  supacrmDataRequestCommand,
  supacrmDataRequestSchema,
} from "../extensions/supacrm-data-request"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmDataRequest = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmDataRequestSchema.parse(input)
  const previous = getSupacrmDataRequest(node.data.details)
  const step = sendTextStepDefaultFn({
    text: supacrmDataRequestCommand(settings),
  })
  if (previous && node.data.details.steps[0]?.stepType === "sendText") {
    step.id = node.data.details.steps[0].id
  }
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        supacrmDataRequest: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: previous
          ? node.data.details.quickReplies
          : ["received", "cancelled", "timeout"].map((label) =>
              buttonStepDefaultFn({ label }),
            ),
      },
    },
  }
}
export const createSupacrmDataRequestNode = (
  props: DefaultNodeProps,
  settings: unknown = {
    valueType: "text",
    variableKey: "input.answer",
    prompt: "Введите данные.",
    invalidMessage: "Проверьте формат и попробуйте ещё раз.",
    maxAttempts: 3,
    timeoutSeconds: 600,
    confirmation: true,
    confirmationPrompt: "Подтвердите введённые данные.",
    confirmLabel: "Подтвердить",
    editLabel: "Изменить",
    cancelLabel: "Отмена",
  },
): SendMessageNodeSchema =>
  configureSupacrmDataRequest(sendMessageNodeDefaultFn(props), settings)
