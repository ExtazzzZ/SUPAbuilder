import {
  createSupacrmFulfillmentNode,
  type SupacrmFulfillment,
} from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"
export function addSupacrmFulfillmentNode(
  reactFlow: Pick<ReactFlowInstance, "addNodes" | "screenToFlowPosition">,
  t: TranslationFn,
  kind: SupacrmFulfillment["kind"],
): void {
  const node = createSupacrmFulfillmentNode(
    {
      dataProps: { name: t(`supacrmFulfillment.${kind}`) },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    },
    kind,
  )
  const labels = {
    completed: "supacrmFulfillment.completed",
    sent: "supacrmFulfillment.sent",
    unknown: "supacrmCheckout.unknown",
    review: "supacrmCheckout.review",
  } as const
  node.data.details.quickReplies = node.data.details.quickReplies.map(
    (port) => ({
      ...port,
      label: t(labels[port.label as keyof typeof labels]),
    }),
  )
  reactFlow.addNodes([node])
}
