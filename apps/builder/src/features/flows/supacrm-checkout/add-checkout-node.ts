import {
  createSupacrmCheckoutNode,
  type SupacrmCheckout,
} from "@chatbotx.io/flow-config"
import type { ReactFlowInstance } from "@xyflow/react"
import type { TranslationFn } from "../react-flow/nodes/types"
import { checkoutTitleKeys } from "./checkout-summary"

const portKeys = {
  applied: "supacrmCheckout.applied",
  refused: "supacrmCheckout.refused",
  continued: "supacrmCheckout.continued",
  confirmed: "supacrmCheckout.confirmed",
  cancelled: "supacrmCheckout.cancelled",
  stale: "supacrmCheckout.stale",
  review: "supacrmCheckout.review",
  email_required: "supacrmCheckout.email_required",
  skipped: "supacrmCheckout.skipped",
  ready: "supacrmCheckout.ready",
  known_failure: "supacrmCheckout.known_failure",
  unknown: "supacrmCheckout.unknown",
  paid: "supacrmCheckout.paid",
} as const
export function addSupacrmCheckoutNode(
  reactFlow: Pick<ReactFlowInstance, "addNodes" | "screenToFlowPosition">,
  t: TranslationFn,
  kind: SupacrmCheckout["kind"],
): void {
  const settings = {
    kind,
    prompt: t("supacrmCheckout.defaultPrompt"),
    cancelLabel: t(
      kind === "wait"
        ? "supacrmCheckout.cancelWait"
        : "supacrmForm.defaultCancelLabel",
    ),
    ...(kind === "wait" ? { timeoutSeconds: 900 } : {}),
    ...(kind === "promo" || kind === "bonus"
      ? { skipLabel: t("supacrmCheckout.defaultSkipLabel") }
      : {}),
    ...(kind === "bonus"
      ? { confirmLabel: t("supacrmCheckout.defaultConfirmLabel") }
      : {}),
    ...(kind === "referral_summary"
      ? { continueLabel: t("supacrmCheckout.defaultContinueLabel") }
      : {}),
  } as SupacrmCheckout
  const node = createSupacrmCheckoutNode(
    {
      dataProps: { name: t(checkoutTitleKeys[kind]) },
      nodeProps: {
        position: reactFlow.screenToFlowPosition({
          x: window.innerWidth - 400,
          y: 100,
        }),
      },
    },
    kind,
    settings,
  )
  node.data.details.quickReplies = node.data.details.quickReplies.map(
    (port) => ({
      ...port,
      label: t(
        port.label === "skipped" && (kind === "promo" || kind === "bonus")
          ? "supacrmCheckout.defaultSkipLabel"
          : portKeys[port.label as keyof typeof portKeys],
      ),
    }),
  )
  reactFlow.addNodes([node])
}
