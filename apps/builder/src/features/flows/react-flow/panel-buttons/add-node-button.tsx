import type { NodeType } from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import {
  ControlButton,
  type ReactFlowInstance,
  useReactFlow,
} from "@xyflow/react"
import { PlusIcon, ShoppingBagIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { addSupacrmCheckoutNode } from "../../supacrm-checkout/add-checkout-node"
import { checkoutTitleKeys } from "../../supacrm-checkout/checkout-summary"
import { addSupacrmDataRequestNode } from "../../supacrm-data-request/add-data-request-node"
import { addSupacrmFormNode } from "../../supacrm-form/add-form-node"
import { addSupacrmFulfillmentNode } from "../../supacrm-fulfillment/add-fulfillment-node"
import { addSupacrmOperatorNode } from "../../supacrm-operator/add-operator-node"
import { addSupacrmProductNode } from "../../supacrm-product/add-product-node"
import { addSupacrmReminderNode } from "../../supacrm-reminder/add-reminder-node"
import { addSupacrmVariableNode } from "../../supacrm-variable/add-variable-node"
import { allNodesConfig } from "../nodes/node-config"
import type { TranslationFn } from "../nodes/types"

export default function AddNodeButton() {
  const [open, setOpen] = useState(false)
  const t = useTranslations()
  const reactFlow = useReactFlow()

  const onClickAction = (nodeType: NodeType) => {
    addNewNode(reactFlow, nodeType, t)
    setOpen(false)
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <ControlButton className="h-9! w-14! bg-primary! p-0! text-primary-foreground!">
            <PlusIcon className="max-h-full! max-w-full! fill-none!" />
          </ControlButton>
        }
      />
      <PopoverContent className="w-max max-w-xs p-2">
        <div className="flex flex-col items-start">
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmReminderNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <PlusIcon />
            {t("supacrmReminder.label")}
          </Button>
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmDataRequestNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <PlusIcon />
            {t("supacrmDataRequest.label")}
          </Button>
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmOperatorNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <PlusIcon />
            {t("supacrmOperator.label")}
          </Button>
          {(["execute", "issue"] as const).map((kind) => (
            <Button
              className="w-full justify-start whitespace-nowrap"
              key={kind}
              onClick={() => {
                addSupacrmFulfillmentNode(reactFlow, t, kind)
                setOpen(false)
              }}
              variant="ghost"
            >
              <PlusIcon />
              {t(`supacrmFulfillment.${kind}`)}
            </Button>
          ))}
          {(
            [
              "promo",
              "bonus",
              "referral_summary",
              "offer",
              "receipt",
              "link",
              "wait",
            ] as const
          ).map((kind) => (
            <Button
              className="w-full justify-start whitespace-nowrap"
              key={kind}
              onClick={() => {
                addSupacrmCheckoutNode(reactFlow, t, kind)
                setOpen(false)
              }}
              variant="ghost"
            >
              <PlusIcon />
              {t(checkoutTitleKeys[kind])}
            </Button>
          ))}
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmFormNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <PlusIcon />
            {t("supacrmForm.label")}
          </Button>
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmProductNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <ShoppingBagIcon />
            {t("supacrmProduct.label")}
          </Button>
          <Button
            className="w-full justify-start whitespace-nowrap"
            onClick={() => {
              addSupacrmVariableNode(reactFlow, t)
              setOpen(false)
            }}
            variant="ghost"
          >
            <PlusIcon />
            {t("supacrmVariable.label")}
          </Button>
          {Object.values(allNodesConfig).map((it, idx) => {
            const item = it?.(t)
            return item ? (
              <Button
                className="w-full justify-start whitespace-nowrap"
                key={item.type}
                onClick={() => onClickAction(item.type)}
                variant="ghost"
              >
                <item.icon />
                {item.label}
              </Button>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: safe return
              <div key={idx} />
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function addNewNode(
  reactFlow: ReactFlowInstance,
  nodeType: NodeType,
  t: TranslationFn,
): string | null {
  const { addNodes, getNodes, screenToFlowPosition } = reactFlow

  const allNodes = getNodes()

  let labelVersion = 1
  for (const node of allNodes) {
    if (node.type === nodeType) {
      labelVersion += 1
    }
  }

  const targetNodeConfig = allNodesConfig[nodeType]?.(t)
  if (!targetNodeConfig) {
    return null
  }
  const newNode = targetNodeConfig.defaultFn?.({
    dataProps: {
      name: `${targetNodeConfig.label} #${labelVersion}`,
    },
    nodeProps: {
      position: screenToFlowPosition({
        x: window.innerWidth - 400,
        y: 100,
      }),
    },
  })
  if (newNode) {
    addNodes([newNode])
  }

  return null
}
