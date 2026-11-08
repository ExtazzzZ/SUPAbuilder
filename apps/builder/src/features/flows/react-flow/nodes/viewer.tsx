import {
  type FlowNode,
  getSupacrmCheckout,
  getSupacrmDataRequest,
  getSupacrmForm,
  getSupacrmFulfillment,
  getSupacrmOperator,
  getSupacrmProduct,
  getSupacrmReminder,
  getSupacrmVariable,
  type NodeType,
  shouldShowDefaultContinue,
} from "@chatbotx.io/flow-config"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { NodeToolbar, Position } from "@xyflow/react"
import { PlayCircleIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { memo } from "react"
import { BaseHandle } from "@/components/base-handle"
import { SupacrmCheckoutSummary } from "../../supacrm-checkout/checkout-summary"
import { SupacrmFormSummary } from "../../supacrm-form/form-summary"
import { SupacrmProductSummary } from "../../supacrm-product/product-summary"
import { SupacrmVariableSummary } from "../../supacrm-variable/variable-summary"
import { DynamicStepViewer } from "../steps"
import { ButtonGroupViewer } from "../steps/button/viewer"
import { FlowNodeToolbar } from "../toolbar/node-toolbar"
import { allNodesConfig } from "./node-config"
import { QuickReplySettingsHandles } from "./quick-reply-settings/quick-reply-settings-handles"

type NodeViewerProps = {
  id: string
  type: NodeType
  data: FlowNode["data"] & { forceToolbarVisible?: boolean }
}

export const NodeViewer = memo((props: NodeViewerProps) => {
  const { id, type, data } = props
  const t = useTranslations()

  const nodeConfig = allNodesConfig[type]?.(t)
  const reminder = getSupacrmReminder(data.details)
  const dataRequest = getSupacrmDataRequest(data.details)
  const operator = getSupacrmOperator(data.details)
  const product = getSupacrmProduct(data.details)
  const variable = getSupacrmVariable(data.details)
  const fulfillment = getSupacrmFulfillment(data.details)
  const checkout = getSupacrmCheckout(data.details)
  const form = getSupacrmForm(data.details)

  return data.details && nodeConfig ? (
    <>
      <div className="absolute min-h-6 w-full -translate-y-full transform">
        {data.isStartNode && (
          <div className="inline-flex items-center gap-1 rounded-xl border bg-destructive px-1.5 py-0.5 text-sm text-white">
            <PlayCircleIcon className="text-sm" size={16} />
            Start
          </div>
        )}
      </div>

      <NodeToolbar isVisible={data.forceToolbarVisible} offset={5}>
        <FlowNodeToolbar isStartNode={data.isStartNode} nodeId={id} />
      </NodeToolbar>

      <Card className="w-72 gap-0 p-0">
        <CardHeader className="relative p-4">
          <BaseHandle
            id={id}
            isConnectableStart={false}
            position={Position.Left}
            type="target"
          />
          <CardTitle className="flex items-center gap-1">
            {nodeConfig?.icon ? <nodeConfig.icon className="size-5" /> : " "}
            {data.name}
          </CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 p-4 pt-0">
          {reminder && (
            <div>
              <p>{t("supacrmReminder.label")}</p>
              <p>
                {reminder.delaySeconds} {t("supacrmReminder.seconds")}
              </p>
            </div>
          )}
          {dataRequest && (
            <div>
              <p>{t("supacrmDataRequest.label")}</p>
              <p>{dataRequest.prompt}</p>
            </div>
          )}
          {operator && (
            <div>
              <p>{t("supacrmOperator.label")}</p>
              <p>
                {operator.reason} · {operator.queue}
              </p>
            </div>
          )}
          {fulfillment && <p>{t(`supacrmFulfillment.${fulfillment.kind}`)}</p>}
          {checkout && <SupacrmCheckoutSummary settings={checkout} />}
          {form && <SupacrmFormSummary settings={form} />}
          {variable && <SupacrmVariableSummary command={variable} />}
          {product && (
            <SupacrmProductSummary catalogItemId={product.catalogItemId} />
          )}
          {!(
            reminder ||
            dataRequest ||
            operator ||
            product ||
            variable ||
            form ||
            checkout ||
            fulfillment
          ) &&
            "steps" in data.details &&
            data.details.steps &&
            data.details.steps.length > 0 &&
            data.details.steps.map((stepItem) => (
              <DynamicStepViewer
                data={stepItem}
                key={stepItem.id}
                nodeId={id}
                type={stepItem.stepType}
              />
            ))}

          {"quickReplies" in data.details &&
            data.details.quickReplies &&
            data.details.quickReplies.length > 0 && (
              <ButtonGroupViewer data={data.details.quickReplies} />
            )}

          {"quickReplySettings" in data.details && (
            <QuickReplySettingsHandles details={data.details} />
          )}

          {shouldShowDefaultContinue(type, data) && (
            <div className="relative w-full text-right">
              {/* React Flow keeps this connector on physical Position.Right. */}
              <span className="mr-4">{t("actions.continue")}</span>
              <BaseHandle id={id} position={Position.Right} type="source" />
            </div>
          )}
        </CardContent>
      </Card>
    </>
  ) : (
    <div>Node not found</div>
  )
})
