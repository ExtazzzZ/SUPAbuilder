import {
  getSupacrmProduct,
  supacrmProductCommand,
} from "../extensions/supacrm-product"
import { buttonStepDefaultFn } from "../steps/button"
import { chooseChannelStepDefaultFn } from "../steps/choose-channel"
import { sendTextStepDefaultFn } from "../steps/send-text"
import type { DefaultNodeProps } from "./base"
import {
  type SendMessageNodeSchema,
  sendMessageNodeDefaultFn,
} from "./send-message"

/** Семантический блок использует существующие API channel/sendText без нового worker step. */
export const createSupacrmProductNode = (
  props: DefaultNodeProps,
): SendMessageNodeSchema => {
  const node = sendMessageNodeDefaultFn(props)
  node.data.details.beforeStep = chooseChannelStepDefaultFn({ channel: "api" })
  node.data.details.supacrmProduct = { catalogItemId: "" }
  return node
}

export const selectSupacrmProduct = (
  node: SendMessageNodeSchema,
  catalogItemId: string,
): SendMessageNodeSchema => {
  const mode = getSupacrmProduct(node.data.details)?.selectTariff
  const text = supacrmProductCommand(catalogItemId, mode)
  const old = node.data.details.steps[0]
  const step = sendTextStepDefaultFn({ text })
  if (getSupacrmProduct(node.data.details) && old?.stepType === "sendText") {
    step.id = old.id
  }
  return {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        beforeStep: { ...node.data.details.beforeStep, channel: "api" },
        supacrmProduct: {
          catalogItemId,
          ...(mode ? { selectTariff: true as const } : {}),
        },
        steps: [step],
        quickReplies: mode ? node.data.details.quickReplies : [],
      },
    },
  }
}

/** Opt-in завершает только выбор тарифа; продолжение использует native button handles. */
export const withSupacrmTariffSelection = (
  node: SendMessageNodeSchema,
  enabled: boolean,
  labels: [string, string] = ["Тариф выбран", "Назад"],
): SendMessageNodeSchema => {
  const product = getSupacrmProduct(node.data.details)
  if (!product) {
    return node
  }
  let quickReplies: SendMessageNodeSchema["data"]["details"]["quickReplies"] =
    []
  if (enabled) {
    quickReplies = product.selectTariff
      ? node.data.details.quickReplies
      : [
          buttonStepDefaultFn({ label: labels[0] }),
          buttonStepDefaultFn({ label: labels[1] }),
        ]
  }
  const changed: SendMessageNodeSchema = {
    ...node,
    data: {
      ...node.data,
      details: {
        ...node.data.details,
        supacrmProduct: {
          catalogItemId: product.catalogItemId,
          ...(enabled ? { selectTariff: true as const } : {}),
        },
        quickReplies,
      },
    },
  }
  return product.catalogItemId
    ? selectSupacrmProduct(changed, product.catalogItemId)
    : changed
}
