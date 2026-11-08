import {
  getSupacrmOperator,
  supacrmOperatorCommand,
  supacrmOperatorSchema,
} from "../extensions/supacrm-operator"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmOperator = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmOperatorSchema.parse(input)
  const previous = getSupacrmOperator(node.data.details)
  const step = sendTextStepDefaultFn({ text: supacrmOperatorCommand(settings) })
  if (previous && node.data.details.steps[0]?.stepType === "sendText") {
    step.id = node.data.details.steps[0].id
  }
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        supacrmOperator: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: previous
          ? node.data.details.quickReplies
          : ["created", "error"].map((label) => buttonStepDefaultFn({ label })),
      },
    },
  }
}
export const createSupacrmOperatorNode = (
  props: DefaultNodeProps,
  settings: unknown = {
    reason: "Запрос клиента",
    queue: "support",
    assigneeId: null,
    stage: "support",
    includeCurrentOrder: true,
    dataKeys: [],
    message: "Заявка передана оператору.",
  },
): SendMessageNodeSchema =>
  configureSupacrmOperator(sendMessageNodeDefaultFn(props), settings)
