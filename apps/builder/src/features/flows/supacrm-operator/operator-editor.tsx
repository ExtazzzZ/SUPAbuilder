"use client"
import {
  configureSupacrmOperator,
  getSupacrmOperator,
  type SendMessageNodeSchema,
  supacrmOperatorSchema,
} from "@chatbotx.io/flow-config"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
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
import { z } from "zod"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"

export function SupacrmOperatorEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const settings = getSupacrmOperator(nodeDetails)
  const editorSchema = supacrmOperatorSchema.extend({
    assigneeId: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? null),
    dataKeysText: z.string().refine(
      (value) =>
        supacrmOperatorSchema.shape.dataKeys.safeParse(
          value
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean),
        ).success,
      t("supacrmOperator.invalidDataKeys"),
    ),
  })
  const form = useForm({
    resolver: zodResolver(editorSchema),
    defaultValues: settings
      ? { ...settings, dataKeysText: settings.dataKeys.join(", ") }
      : undefined,
  })
  useEffect(() => {
    const value = getSupacrmOperator(nodeDetails)
    if (value) {
      form.reset({ ...value, dataKeysText: value.dataKeys.join(", ") })
    }
  }, [nodeDetails, form])
  if (!settings) {
    return null
  }
  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((value) => {
          const node = getNode(nodeId) as SendMessageNodeSchema | undefined
          if (!node) {
            return
          }
          const { dataKeysText, ...payload } = value
          takeSnapshot()
          updateNodeData(
            nodeId,
            configureSupacrmOperator(node, {
              ...payload,
              dataKeys: dataKeysText
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            }).data,
          )
        })}
      >
        <p>{t("supacrmOperator.description")}</p>
        <InputField
          label={t("supacrmOperator.reason")}
          name="reason"
          required
        />
        <InputField label={t("supacrmOperator.queue")} name="queue" required />
        <InputNumberField
          label={t("supacrmOperator.assigneeId")}
          min={1}
          name="assigneeId"
        />
        <SelectField
          label={t("supacrmOperator.stage")}
          name="stage"
          options={[
            { value: "onboarding", label: t("supacrmOperator.onboarding") },
            { value: "fulfillment", label: t("supacrmOperator.fulfillment") },
            { value: "support", label: t("supacrmOperator.support") },
          ]}
        />
        <SwitchField
          label={t("supacrmOperator.includeCurrentOrder")}
          name="includeCurrentOrder"
        />
        <InputField label={t("supacrmOperator.dataKeys")} name="dataKeysText" />
        <TextareaField
          label={t("supacrmOperator.message")}
          name="message"
          required
        />
        <Button type="submit">{t("supacrmForm.save")}</Button>
      </form>
    </Form>
  )
}
