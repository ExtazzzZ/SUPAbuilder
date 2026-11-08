"use client"

import {
  getSupacrmVariable,
  type SendMessageNodeSchema,
  selectSupacrmVariable,
  supacrmVariableSchema,
} from "@chatbotx.io/flow-config"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { useReactFlow } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useForm } from "react-hook-form"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"

export const variableActionLabels = {
  "variables.render": "supacrmVariable.render",
  "variables.condition": "supacrmVariable.condition",
  "variables.set": "supacrmVariable.set",
  "variables.reset": "supacrmVariable.reset",
} as const

export function SupacrmVariableEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const initial = getSupacrmVariable(nodeDetails)
  const payload = initial?.payload
  const form = useForm({
    defaultValues: {
      action: initial?.action ?? "variables.render",
      key: payload?.key ?? "",
      template:
        payload && "template" in payload ? payload.template : "{{value}}",
      operator: payload && "operator" in payload ? payload.operator : "eq",
      operand: JSON.stringify(
        payload && "operand" in payload ? payload.operand : null,
      ),
      then_text: payload && "then_text" in payload ? payload.then_text : "",
      else_text: payload && "else_text" in payload ? payload.else_text : "",
      value: JSON.stringify(
        payload && "value" in payload ? payload.value : null,
      ),
      value_from:
        payload && "value_from" in payload
          ? (payload.value_from ?? "literal")
          : "literal",
      explicit_cas:
        payload &&
        "expected_revision" in payload &&
        payload.expected_revision !== undefined &&
        "source_fingerprint" in payload &&
        payload.source_fingerprint !== undefined,
      expected_revision:
        payload && "expected_revision" in payload
          ? payload.expected_revision
          : 0,
      source_fingerprint:
        payload && "source_fingerprint" in payload
          ? payload.source_fingerprint
          : "",
      confirmation:
        payload && "confirmation" in payload ? payload.confirmation : "",
    },
  })
  const action = form.watch("action")
  const mutation = action === "variables.set" || action === "variables.reset"
  const explicitCas = form.watch("explicit_cas")
  const valueFrom = form.watch("value_from")
  const submit = form.handleSubmit((fields) => {
    try {
      let next: Record<string, unknown> = { key: fields.key }
      if (fields.action === "variables.render") {
        next = { ...next, template: fields.template }
      }
      if (fields.action === "variables.condition") {
        next = {
          ...next,
          operator: fields.operator,
          operand: JSON.parse(fields.operand),
          then_text: fields.then_text,
          else_text: fields.else_text,
        }
      }
      if (
        fields.action === "variables.set" ||
        fields.action === "variables.reset"
      ) {
        next = {
          ...next,
          ...(fields.explicit_cas
            ? {
                expected_revision: fields.expected_revision,
                source_fingerprint: fields.source_fingerprint,
              }
            : {}),
          confirmation: fields.confirmation,
        }
      }
      if (fields.action === "variables.set") {
        if (fields.value_from === "inbound_text") {
          next.value_from = "inbound_text"
        } else {
          next.value = JSON.parse(fields.value)
          if (
            payload &&
            "value_from" in payload &&
            payload.value_from === "literal"
          ) {
            next.value_from = "literal"
          }
        }
      }
      const command = supacrmVariableSchema.parse({
        action: fields.action,
        payload: next,
      })
      const node = getNode(nodeId) as SendMessageNodeSchema | undefined
      if (!node) {
        return
      }
      const compiled = selectSupacrmVariable(node, command)
      takeSnapshot()
      updateNodeData(nodeId, compiled.data)
      form.clearErrors()
    } catch {
      form.setError("root", { message: t("supacrmVariable.invalid") })
    }
  })
  return (
    <Form {...form}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <p className="text-muted-foreground text-sm">
          {t("supacrmVariable.description")}
        </p>
        <SelectField
          label={t("supacrmVariable.action")}
          name="action"
          options={Object.entries(variableActionLabels).map(
            ([value, label]) => ({ value, label: t(label) }),
          )}
        />
        <InputField label={t("supacrmVariable.key")} name="key" required />
        {action === "variables.render" && (
          <TextareaField
            label={t("supacrmVariable.template")}
            name="template"
          />
        )}
        {action === "variables.condition" && (
          <>
            <SelectField
              label={t("supacrmVariable.operator")}
              name="operator"
              options={[
                "eq",
                "contains",
                "starts_with",
                "gt",
                "gte",
                "lte",
              ].map((value) => ({ value, label: value }))}
            />
            <TextareaField
              label={t("supacrmVariable.operand")}
              name="operand"
            />
            <TextareaField
              label={t("supacrmVariable.thenText")}
              name="then_text"
            />
            <TextareaField
              label={t("supacrmVariable.elseText")}
              name="else_text"
            />
          </>
        )}
        {action === "variables.set" && (
          <>
            <SelectField
              label={t("supacrmVariable.valueFrom")}
              name="value_from"
              options={[
                { value: "literal", label: t("supacrmVariable.literal") },
                {
                  value: "inbound_text",
                  label: t("supacrmVariable.inboundText"),
                },
              ]}
            />
            {valueFrom === "literal" ? (
              <TextareaField label={t("supacrmVariable.value")} name="value" />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("supacrmVariable.inboundWarning")}
              </p>
            )}
          </>
        )}
        {mutation && (
          <>
            <SwitchField
              label={t("supacrmVariable.explicitCas")}
              name="explicit_cas"
            />
            <p className="text-muted-foreground text-sm">
              {t(
                explicitCas
                  ? "supacrmVariable.casWarning"
                  : "supacrmVariable.autoCas",
              )}
            </p>
            {explicitCas && (
              <>
                <InputNumberField
                  label={t("supacrmVariable.revision")}
                  min={0}
                  name="expected_revision"
                />
                <InputField
                  label={t("supacrmVariable.fingerprint")}
                  name="source_fingerprint"
                />
              </>
            )}
            <TextareaField
              label={t("supacrmVariable.confirmation")}
              name="confirmation"
            />
          </>
        )}
        {form.formState.errors.root && (
          <p className="text-destructive text-sm" role="alert">
            {form.formState.errors.root.message}
          </p>
        )}
        <Button type="submit">{t("supacrmVariable.apply")}</Button>
      </form>
    </Form>
  )
}
