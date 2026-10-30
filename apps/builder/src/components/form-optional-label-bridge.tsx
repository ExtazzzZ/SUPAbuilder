"use client"

import { FormOptionalLabelProvider } from "@chatbotx.io/ui/components/form/optional-label-context"
import { CalendarLocaleProvider } from "@chatbotx.io/ui/components/ui/calendar-locale-context"
import { useLocale, useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { toDateFnsLocale } from "@/lib/date-fns-locale"

/**
 * Передаёт язык конструктора общим подписям полей и календарям.
 * Компоненты packages/ui используют эти значения без зависимости от next-intl.
 */
export function FormOptionalLabelBridge({ children }: { children: ReactNode }) {
  const t = useTranslations("fields")
  const calendar = useTranslations("recurrence.end")
  const locale = useLocale()

  return (
    <FormOptionalLabelProvider value={t("optionalHint")}>
      <CalendarLocaleProvider
        value={{
          locale: toDateFnsLocale(locale),
          pickDate: calendar("pickDate"),
        }}
      >
        {children}
      </CalendarLocaleProvider>
    </FormOptionalLabelProvider>
  )
}
