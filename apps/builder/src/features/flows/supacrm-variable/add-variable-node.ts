import { createSupacrmVariableNode } from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"

export function addSupacrmVariableNode(
  flow: ReactFlowInstance,
  t: TranslationFn,
): void {
  flow.addNodes([
    createSupacrmVariableNode({
      dataProps: { name: t("supacrmVariable.label") },
      nodeProps: {
        position: flow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    }),
  ])
}
