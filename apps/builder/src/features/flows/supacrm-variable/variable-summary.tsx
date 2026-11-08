"use client"
import type { SupacrmVariable } from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"

const labels = {
  "variables.render": "supacrmVariable.render",
  "variables.condition": "supacrmVariable.condition",
  "variables.set": "supacrmVariable.set",
  "variables.reset": "supacrmVariable.reset",
} as const
export function SupacrmVariableSummary({
  command,
}: {
  command: SupacrmVariable
}) {
  const t = useTranslations()
  return (
    <div className="text-sm">
      <p>{t(labels[command.action])}</p>
      <p className="text-muted-foreground">
        {command.payload.key || t("supacrmVariable.chooseKey")}
      </p>
    </div>
  )
}
