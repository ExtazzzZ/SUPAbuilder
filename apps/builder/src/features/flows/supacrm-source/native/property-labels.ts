"use client"

import { useTranslations } from "next-intl"

export function useNativeSourcePropertyLabels() {
  const t = useTranslations("supacrmNativeSource.properties")
  return {
    description: t("description"),
    loading: t("loading"),
    readonly: t("readonly"),
    error: t("error"),
    sourceId: t("sourceId"),
    scenarioId: t("scenarioId"),
    kind: t("kind"),
  }
}

export function useNativeSourceMessageLabels() {
  const t = useTranslations("supacrmNativeSource.message")
  return {
    title: t("title"),
    loading: t("loading"),
    unavailable: t("unavailable"),
    save: t("save"),
    saving: t("saving"),
    saveError: t("saveError"),
    readOnly: t("readOnly"),
    reload: t("reload"),
    unknown: t("unknown"),
  }
}
