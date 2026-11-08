"use client"

import {
  configureSupacrmEmail,
  getSupacrmForm,
  type SendMessageNodeSchema,
  supacrmFormSchema,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useReactFlow } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"
import { ReceiptEmailTemplateEditor } from "./template-editor"

const fields = [
  "prompt",
  "invalidMessage",
  "confirmationPrompt",
  "confirmLabel",
  "editLabel",
  "cancelLabel",
] as const

export function SupacrmFormEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const [settings, setSettings] = useState(() => getSupacrmForm(nodeDetails))
  const [invalid, setInvalid] = useState(false)
  const [binding, setBinding] = useState(nodeDetails.supacrmFormTemplate)
  useEffect(() => {
    setSettings(getSupacrmForm(nodeDetails))
    setBinding(nodeDetails.supacrmFormTemplate)
    setInvalid(false)
  }, [nodeDetails])
  if (!settings) {
    return null
  }
  return (
    <div className="space-y-4">
      <ReceiptEmailTemplateEditor
        binding={binding}
        nodeId={nodeId}
        onApplied={(node) => {
          setSettings(getSupacrmForm(node.data.details))
          setBinding(node.data.details.supacrmFormTemplate)
        }}
        settings={settings}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          const parsed = supacrmFormSchema.safeParse(settings)
          setInvalid(!parsed.success)
          const current = getNode(nodeId) as SendMessageNodeSchema | undefined
          if (!(parsed.success && current)) {
            return
          }
          if (binding) {
            return
          }
          takeSnapshot()
          updateNodeData(nodeId, {
            ...configureSupacrmEmail(current, parsed.data).data,
          })
        }}
      >
        {binding && (
          <p className="text-muted-foreground text-sm">
            {t("supacrmTemplate.readOnly")}
          </p>
        )}
        <p className="text-muted-foreground text-sm">
          {t("supacrmForm.description")}
        </p>
        {fields.map((key) => (
          <label className="flex flex-col gap-2 text-sm" key={key}>
            {t(`supacrmForm.${key}`)}
            <textarea
              className="min-h-16 rounded-md border p-2"
              disabled={Boolean(binding)}
              maxLength={key.endsWith("Label") ? 40 : 500}
              name={key}
              onChange={(event) =>
                setSettings({ ...settings, [key]: event.target.value })
              }
              value={settings[key]}
            />
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={settings.useSavedEmail}
            disabled={Boolean(binding)}
            onChange={(event) =>
              setSettings({ ...settings, useSavedEmail: event.target.checked })
            }
            type="checkbox"
          />
          {t("supacrmForm.useSavedEmail")}
        </label>
        <p className="text-muted-foreground text-sm">
          {t("supacrmForm.validator")}
        </p>
        {invalid && <p role="alert">{t("supacrmForm.invalidSettings")}</p>}
        <Button disabled={Boolean(binding)} type="submit">
          {t("supacrmForm.save")}
        </Button>
      </form>
    </div>
  )
}
