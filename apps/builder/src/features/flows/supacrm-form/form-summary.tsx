"use client"

import type { SupacrmForm } from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"

export function SupacrmFormSummary({ settings }: { settings: SupacrmForm }) {
  const t = useTranslations()
  return (
    <div className="text-sm">
      <p className="font-medium">{t("supacrmForm.label")}</p>
      <p className="whitespace-pre-wrap text-muted-foreground">
        {settings.prompt}
      </p>
    </div>
  )
}
