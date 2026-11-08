import {
  fulfillmentPorts,
  getSupacrmFulfillment,
  type SupacrmFulfillment,
  supacrmFulfillmentCommand,
  supacrmFulfillmentSchema,
} from "../extensions/supacrm-fulfillment"
import { buttonStepDefaultFn } from "../steps/button"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

export const configureSupacrmFulfillment = (
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema => {
  const settings = supacrmFulfillmentSchema.parse(input)
  const previous = getSupacrmFulfillment(node.data.details)
  if (previous && previous.kind !== settings.kind) {
    throw new Error("fulfillment_kind_immutable")
  }
  if (
    node.data.details.supacrmCheckout ||
    node.data.details.supacrmForm ||
    node.data.details.supacrmProduct ||
    node.data.details.supacrmVariable ||
    node.data.details.supacrmFormTemplate
  ) {
    throw new Error("fulfillment_requires_own_node")
  }
  const step = sendTextStepDefaultFn({
    text: supacrmFulfillmentCommand(settings),
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
        supacrmFulfillment: settings,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        steps: [step],
        quickReplies: previous
          ? node.data.details.quickReplies
          : fulfillmentPorts[settings.kind].map((label) =>
              buttonStepDefaultFn({ label }),
            ),
      },
    },
  }
}
export const createSupacrmFulfillmentNode = (
  props: DefaultNodeProps,
  kind: SupacrmFulfillment["kind"],
): SendMessageNodeSchema =>
  configureSupacrmFulfillment(
    sendMessageNodeDefaultFn(props),
    kind === "execute"
      ? { kind, strategy: "apple_code_us_v1" }
      : {
          kind,
          plan: {
            kind: "apple_us_delivery_v1",
            requiredParts: [
              {
                key: "author_instruction",
                kind: "plain_instruction",
                required: true,
                text: "Используйте код в App Store для региона США.",
              },
              {
                key: "apple_code_reference",
                kind: "provider_apple_reference",
                required: true,
              },
            ],
          },
        },
  )
