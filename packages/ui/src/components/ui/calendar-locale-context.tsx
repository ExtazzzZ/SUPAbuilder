"use client"

import type { Locale } from "date-fns"
import { enUS } from "date-fns/locale"
import { createContext, type ReactNode, useContext } from "react"

type CalendarLocale = {
  locale: Locale
  pickDate: string
}

const CalendarLocaleContext = createContext<CalendarLocale>({
  locale: enUS,
  pickDate: "Pick a date",
})

/** Приложения передают свой язык без зависимости общих полей от системы переводов. */
export function CalendarLocaleProvider({
  value,
  children,
}: {
  value: CalendarLocale
  children: ReactNode
}) {
  return (
    <CalendarLocaleContext.Provider value={value}>
      {children}
    </CalendarLocaleContext.Provider>
  )
}

export function useCalendarLocale() {
  return useContext(CalendarLocaleContext)
}
