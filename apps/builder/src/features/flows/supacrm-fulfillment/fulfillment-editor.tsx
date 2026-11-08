"use client"
import {
  configureSupacrmFulfillment,
  getSupacrmFulfillment,
  type SendMessageNodeSchema,
  supacrmFulfillmentSchema,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { useReactFlow } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"

export function SupacrmFulfillmentEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const [settings, setSettings] = useState(() =>
    getSupacrmFulfillment(nodeDetails),
  )
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setSettings(getSupacrmFulfillment(nodeDetails))
    setInvalid(false)
  }, [nodeDetails])
  if (!settings) {
    return null
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        const result = supacrmFulfillmentSchema.safeParse(settings)
        setInvalid(!result.success)
        const node = getNode(nodeId) as SendMessageNodeSchema | undefined
        if (!(result.success && node)) {
          return
        }
        takeSnapshot()
        updateNodeData(
          nodeId,
          configureSupacrmFulfillment(node, result.data).data,
        )
      }}
    >
      <p>
        {t(
          settings.kind === "execute"
            ? "supacrmFulfillment.executeInput"
            : "supacrmFulfillment.issueInput",
        )}
      </p>
      {settings.kind === "issue" && (
        <>
          <Label htmlFor={`${nodeId}-instruction`}>
            {t("supacrmFulfillment.instruction")}
          </Label>
          <Textarea
            id={`${nodeId}-instruction`}
            maxLength={2000}
            onChange={(event) =>
              setSettings({
                ...settings,
                plan: {
                  ...settings.plan,
                  requiredParts: [
                    {
                      ...settings.plan.requiredParts[0],
                      text: event.target.value,
                    },
                    settings.plan.requiredParts[1],
                  ],
                },
              })
            }
            value={settings.plan.requiredParts[0].text}
          />
          <p className="text-muted-foreground text-sm">
            {t("supacrmFulfillment.limit")}
          </p>
          <p>{t("supacrmFulfillment.core")}</p>
        </>
      )}
      {invalid && <p role="alert">{t("supacrmFulfillment.invalid")}</p>}
      <Button type="submit">{t("supacrmForm.save")}</Button>
    </form>
  )
}
