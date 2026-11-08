import { createSupacrmEmailNode } from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"

export function addSupacrmFormNode(
  reactFlow: ReactFlowInstance,
  t: TranslationFn,
): void {
  reactFlow.addNodes([
    createSupacrmEmailNode(
      {
        dataProps: { name: t("supacrmForm.label") },
        nodeProps: {
          position: reactFlow.screenToFlowPosition({
            x: window.innerWidth - 400,
            y: 100,
          }),
        },
      },
      {
        kind: "receiptEmail",
        prompt: t("supacrmForm.defaultPrompt"),
        invalidMessage: t("supacrmForm.defaultInvalid"),
        confirmationPrompt: t("supacrmForm.defaultConfirmation"),
        confirmLabel: t("supacrmForm.defaultConfirmLabel"),
        editLabel: t("supacrmForm.defaultEditLabel"),
        cancelLabel: t("supacrmForm.defaultCancelLabel"),
        useSavedEmail: true,
        validator: "crmReceiptEmail",
      },
    ),
  ])
}
