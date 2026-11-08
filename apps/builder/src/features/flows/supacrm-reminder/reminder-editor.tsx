"use client"
import {
  configureSupacrmReminder,
  getSupacrmReminder,
  type SendMessageNodeSchema,
  type SupacrmReminder,
  supacrmReminderSchema,
} from "@chatbotx.io/flow-config"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useReactFlow } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"
export function SupacrmReminderEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const form = useForm<SupacrmReminder>({
    resolver: zodResolver(supacrmReminderSchema),
    defaultValues: getSupacrmReminder(nodeDetails) ?? undefined,
  })
  useEffect(() => {
    const value = getSupacrmReminder(nodeDetails)
    if (value) {
      form.reset(value)
    }
  }, [nodeDetails, form])
  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((value) => {
          const node = getNode(nodeId) as SendMessageNodeSchema | undefined
          if (node) {
            takeSnapshot()
            updateNodeData(nodeId, configureSupacrmReminder(node, value).data)
          }
        })}
      >
        <p>{t("supacrmReminder.description")}</p>
        <SelectField
          label={t("supacrmReminder.anchor")}
          name="anchor"
          options={[
            {
              value: "order_created",
              label: t("supacrmReminder.order_created"),
            },
            { value: "link_issued", label: t("supacrmReminder.link_issued") },
            { value: "paid", label: t("supacrmReminder.paid") },
            { value: "delivered", label: t("supacrmReminder.delivered") },
            {
              value: "customer_confirmed",
              label: t("supacrmReminder.customer_confirmed"),
            },
          ]}
          required
        />
        <InputNumberField
          label={t("supacrmReminder.delaySeconds")}
          max={2_592_000}
          min={0}
          name="delaySeconds"
          required
        />
        <SelectField
          label={t("supacrmReminder.action")}
          name="action"
          options={[
            { value: "message", label: t("supacrmReminder.messageAction") },
            { value: "continue", label: t("supacrmReminder.continueAction") },
          ]}
          required
        />
        <TextareaField
          label={t("supacrmReminder.message")}
          name="message"
          required
        />
        <SwitchField
          label={t("supacrmReminder.cancelOnPaid")}
          name="cancelOnPaid"
        />
        <SwitchField
          label={t("supacrmReminder.cancelOnReply")}
          name="cancelOnReply"
        />
        <SwitchField
          label={t("supacrmReminder.cancelOnOrderCancelled")}
          name="cancelOnOrderCancelled"
        />
        <Button type="submit">{t("supacrmForm.save")}</Button>
      </form>
    </Form>
  )
}
