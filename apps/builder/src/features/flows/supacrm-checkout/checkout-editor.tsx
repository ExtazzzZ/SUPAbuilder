"use client"
import {
  configureSupacrmCheckout,
  getSupacrmCheckout,
  type SendMessageNodeSchema,
  supacrmCheckoutSchema,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { useReactFlow } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"

export function SupacrmCheckoutEditor({
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
    getSupacrmCheckout(nodeDetails),
  )
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setSettings(getSupacrmCheckout(nodeDetails))
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
        const result = supacrmCheckoutSchema.safeParse(settings)
        setInvalid(!result.success)
        const node = getNode(nodeId) as SendMessageNodeSchema | undefined
        if (!(result.success && node)) {
          return
        }
        takeSnapshot()
        updateNodeData(nodeId, configureSupacrmCheckout(node, result.data).data)
      }}
    >
      <p className="text-muted-foreground text-sm">
        {t("supacrmCheckout.description")}
      </p>
      <Label htmlFor={`${nodeId}-prompt`}>{t("supacrmCheckout.prompt")}</Label>
      <Textarea
        id={`${nodeId}-prompt`}
        maxLength={500}
        onChange={(e) => setSettings({ ...settings, prompt: e.target.value })}
        value={settings.prompt}
      />
      <Label htmlFor={`${nodeId}-cancel`}>
        {t("supacrmCheckout.cancelLabel")}
      </Label>
      <Input
        id={`${nodeId}-cancel`}
        maxLength={40}
        onChange={(e) =>
          setSettings({ ...settings, cancelLabel: e.target.value })
        }
        value={settings.cancelLabel}
      />
      {(["skipLabel", "confirmLabel", "continueLabel"] as const).map((field) =>
        field in settings ? (
          <div className="flex flex-col gap-2"key={field} >
            <Label htmlFor={`${nodeId}-${field}`}>{t(`supacrmCheckout.${field}`)}</Label>
            <Input id={`${nodeId}-${field}`} maxLength={40} 
              onChange={(e) => setSettings({ ...settings, [field]: e.target.value })} value={(settings as unknown as Record<string, string>)[field]}/>
          </div>
        ) : null,
      )}
      {settings.kind === "wait" && (
        <>
          <Label htmlFor={`${nodeId}-timeout`}>
            {t("supacrmCheckout.timeout")}
          </Label>
          <Input
            id={`${nodeId}-timeout`}
            max={86_400}
            min={30}
            onChange={(e) =>
              setSettings({
                ...settings,
                timeoutSeconds: Number(e.target.value),
              })
            }
            type="number"
            value={settings.timeoutSeconds}
          />
          <p className="text-muted-foreground text-sm">
            {t("supacrmCheckout.waitNotice")}
          </p>
        </>
      )}
      {invalid && <p role="alert">{t("supacrmCheckout.invalid")}</p>}
      <Button type="submit">{t("supacrmForm.save")}</Button>
    </form>
  )
}
