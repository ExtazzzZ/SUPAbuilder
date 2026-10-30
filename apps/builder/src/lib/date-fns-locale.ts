import type { Locale as DateFnsLocale } from "date-fns"
import {
  ar,
  az,
  da,
  de,
  enUS,
  es,
  fi,
  fr,
  he,
  id,
  it,
  ja,
  nl,
  pt,
  ptBR,
  ro,
  ru,
  sv,
  tr,
  vi,
  zhCN,
  zhTW,
} from "react-day-picker/locale"
import { type Locale, resolveLocale } from "@/i18n/config"

/** The date-fns locale of each app locale (calendar month/day names, `PP` dates). */
const DATE_FNS_LOCALES: Record<Locale, DateFnsLocale> = {
  ar,
  az,
  da,
  de,
  en: enUS,
  es,
  fi,
  fr,
  he,
  id,
  it,
  ja,
  nl,
  "pt-BR": ptBR,
  "pt-PT": pt,
  ro,
  ru,
  sv,
  tr,
  vi,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
}

/** Локаль date-fns для выбранного языка приложения. */
export const toDateFnsLocale = (locale: string): DateFnsLocale =>
  DATE_FNS_LOCALES[resolveLocale(locale)]
