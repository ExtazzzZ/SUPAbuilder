import { createSupacrmReminderNode } from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"
export function addSupacrmReminderNode(
  reactFlow: Pick<ReactFlowInstance, "addNodes" | "screenToFlowPosition">,
  t: TranslationFn,
): void {
  const node = createSupacrmReminderNode(
    {
      dataProps: { name: t("supacrmReminder.label") },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    },
    {
      anchor: "link_issued",
      delaySeconds: 900,
      action: "message",
      message: t("supacrmReminder.defaultMessage"),
      cancelOnPaid: true,
      cancelOnReply: true,
      cancelOnOrderCancelled: true,
    },
  )
  node.data.details.quickReplies = node.data.details.quickReplies.map(
    (port, i) => ({
      ...port,
      label: t(i === 0 ? "supacrmReminder.fired" : "supacrmReminder.cancelled"),
    }),
  )
  reactFlow.addNodes([node])
}
