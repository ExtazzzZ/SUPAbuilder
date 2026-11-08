import {
  getSupacrmReminder,
  supacrmReminderCommand,
  supacrmReminderSchema,
} from "../extensions/supacrm-reminder"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmReminder = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmReminderSchema.parse(input)
  const previous = getSupacrmReminder(node.data.details)
  const step = sendTextStepDefaultFn({
    text: supacrmReminderCommand(settings),
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
        supacrmReminder: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: previous
          ? node.data.details.quickReplies
          : ["fired", "cancelled"].map((label) =>
              buttonStepDefaultFn({ label }),
            ),
      },
    },
  }
}
export const createSupacrmReminderNode = (
  props: DefaultNodeProps,
  settings: unknown = {
    anchor: "link_issued",
    delaySeconds: 900,
    action: "message",
    message: "Ваш заказ ожидает продолжения.",
    cancelOnPaid: true,
    cancelOnReply: true,
    cancelOnOrderCancelled: true,
  },
): SendMessageNodeSchema =>
  configureSupacrmReminder(sendMessageNodeDefaultFn(props), settings)
