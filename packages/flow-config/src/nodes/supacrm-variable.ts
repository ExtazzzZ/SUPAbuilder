import {
  type SupacrmVariable,
  supacrmVariableCommand,
} from "../extensions/supacrm-variable"
import { chooseChannelStepDefaultFn } from "../steps/choose-channel"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const createSupacrmVariableNode = (
  props: DefaultNodeProps,
): SendMessageNodeSchema => {
  const node = sendMessageNodeDefaultFn(props)
  node.data.details.beforeStep = chooseChannelStepDefaultFn({ channel: "api" })
  node.data.details.supacrmVariable = {
    action: "variables.render",
    payload: { key: "", template: "{{value}}" },
  }
  return node
}

export const selectSupacrmVariable = (
  node: SendMessageNodeSchema,
  command: SupacrmVariable,
): SendMessageNodeSchema => {
  const step = sendTextStepDefaultFn({ text: supacrmVariableCommand(command) })
  const old = node.data.details.steps[0]
  if (old?.stepType === "sendText") {
    step.id = old.id
  }
  const { supacrmProduct: _product, ...details } = node.data.details
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...details,
        beforeStep: { ...details.beforeStep, channel: "api" },
        supacrmVariable: command,
        steps: [step],
        quickReplies: [],
      },
    },
  }
}
