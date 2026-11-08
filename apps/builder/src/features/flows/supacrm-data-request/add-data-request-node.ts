import { createSupacrmDataRequestNode } from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"
export function addSupacrmDataRequestNode(
  reactFlow: Pick<ReactFlowInstance, "addNodes" | "screenToFlowPosition">,
  t: TranslationFn,
): void {
  const node = createSupacrmDataRequestNode(
    {
      dataProps: { name: t("supacrmDataRequest.label") },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    },
    {
      valueType: "text",
      variableKey: "input.answer",
      prompt: t("supacrmDataRequest.defaultPrompt"),
      invalidMessage: t("supacrmDataRequest.defaultInvalid"),
      maxAttempts: 3,
      timeoutSeconds: 600,
      confirmation: true,
      confirmationPrompt: t("supacrmDataRequest.defaultConfirmation"),
      confirmLabel: t("supacrmDataRequest.defaultConfirm"),
      editLabel: t("supacrmDataRequest.defaultEdit"),
      cancelLabel: t("supacrmDataRequest.defaultCancel"),
    },
  )
  node.data.details.quickReplies = node.data.details.quickReplies.map(
    (port, i) => ({
      ...port,
      label: t(
        (
          [
            "supacrmDataRequest.received",
            "supacrmDataRequest.cancelled",
            "supacrmDataRequest.timeout",
          ] as const
        )[i],
      ),
    }),
  )
  reactFlow.addNodes([node])
}
