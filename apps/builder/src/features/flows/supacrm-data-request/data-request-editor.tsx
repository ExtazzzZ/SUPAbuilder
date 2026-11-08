"use client"
import {
  configureSupacrmDataRequest,
  getSupacrmDataRequest,
  type SendMessageNodeSchema,
  type SupacrmDataRequest,
  supacrmDataRequestSchema,
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
import { useFlowHistory } from "../react-flow/stores/use-flow-history"
export function SupacrmDataRequestEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const form = useForm<SupacrmDataRequest>({
    resolver: zodResolver(supacrmDataRequestSchema),
    defaultValues: getSupacrmDataRequest(nodeDetails) ?? undefined,
  })
  useEffect(() => {
    const value = getSupacrmDataRequest(nodeDetails)
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
            updateNodeData(
              nodeId,
              configureSupacrmDataRequest(node, value).data,
            )
          }
        })}
      >
        <p>{t("supacrmDataRequest.description")}</p>
        <SelectField
          label={t("supacrmDataRequest.valueType")}
          name="valueType"
          options={[
            { value: "email", label: t("supacrmDataRequest.email") },
            { value: "number", label: t("supacrmDataRequest.number") },
            { value: "text", label: t("supacrmDataRequest.text") },
            { value: "phone", label: t("supacrmDataRequest.phone") },
          ]}
          required
        />
        <InputField
          label={t("supacrmDataRequest.variableKey")}
          name="variableKey"
        />
        <TextareaField label={t("supacrmDataRequest.prompt")} name="prompt" />
        <TextareaField
          label={t("supacrmDataRequest.invalidMessage")}
          name="invalidMessage"
        />
        <InputNumberField
          label={t("supacrmDataRequest.maxAttempts")}
          max={10}
          min={1}
          name="maxAttempts"
        />
        <InputNumberField
          label={t("supacrmDataRequest.timeoutSeconds")}
          max={86_400}
          min={30}
          name="timeoutSeconds"
        />
        <SwitchField
          label={t("supacrmDataRequest.confirmation")}
          name="confirmation"
        />
        <TextareaField
          label={t("supacrmDataRequest.confirmationPrompt")}
          name="confirmationPrompt"
        />
        <InputField
          label={t("supacrmDataRequest.confirmLabel")}
          name="confirmLabel"
        />
        <InputField
          label={t("supacrmDataRequest.editLabel")}
          name="editLabel"
        />
        <InputField
          label={t("supacrmDataRequest.cancelLabel")}
          name="cancelLabel"
        />
        <Button type="submit">{t("supacrmForm.save")}</Button>
      </form>
    </Form>
  )
}
