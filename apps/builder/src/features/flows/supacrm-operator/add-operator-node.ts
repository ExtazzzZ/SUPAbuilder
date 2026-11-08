import { createSupacrmOperatorNode } from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"
export function addSupacrmOperatorNode(
  reactFlow: Pick<ReactFlowInstance, "addNodes" | "screenToFlowPosition">,
  t: TranslationFn,
): void {
  const node = createSupacrmOperatorNode(
    {
      dataProps: { name: t("supacrmOperator.label") },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    },
    {
      reason: t("supacrmOperator.defaultReason"),
      queue: "support",
      assigneeId: null,
      stage: "support",
      includeCurrentOrder: true,
      dataKeys: [],
      message: t("supacrmOperator.defaultMessage"),
    },
  )
  node.data.details.quickReplies = node.data.details.quickReplies.map(
    (port, i) => ({
      ...port,
      label: t(i === 0 ? "supacrmOperator.created" : "supacrmOperator.error"),
    }),
  )
  reactFlow.addNodes([node])
}
