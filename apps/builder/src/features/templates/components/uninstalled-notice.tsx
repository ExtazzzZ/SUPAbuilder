"use client"

import type {
  TemplateUninstallCounts,
  TemplateUninstallRequester,
} from "@chatbotx.io/database/partials"
import { useTranslations } from "next-intl"

type UninstalledNoticeProps = {
  uninstalledBy: TemplateUninstallRequester | null | undefined
  counts: TemplateUninstallCounts
  /** One line for a table cell; otherwise a banner with the full breakdown. */
  compact?: boolean
}

/**
 * Says who uninstalled the template and what became of the copies: the numbers
 * are the ones the uninstall recorded, so the installer sees what was deleted
 * and what they still own.
 */
export function UninstalledNotice({
  uninstalledBy,
  counts,
  compact = false,
}: UninstalledNoticeProps) {
  const t = useTranslations("templates.installs")
  const tUninstall = useTranslations("templates.uninstall")
  const kept =
    counts.keptModified +
    counts.keptShared +
    counts.keptByPolicy +
    counts.keptHasDependents
  const who = t("uninstalledBy", { by: uninstalledBy ?? "unknown" })

  if (compact) {
    return (
      <span className="text-muted-foreground text-xs">
        {who} {t("uninstalledSummary", { deleted: counts.deleted, kept })}
      </span>
    )
  }
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm" role="status">
      <p className="font-medium">{who}</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
        <li>{tUninstall("deleted", { count: counts.deleted })}</li>
        <li>{tUninstall("keptModified", { count: counts.keptModified })}</li>
        <li>{tUninstall("keptShared", { count: counts.keptShared })}</li>
        <li>{tUninstall("keptByPolicy", { count: counts.keptByPolicy })}</li>
        {counts.keptHasDependents > 0 && (
          <li>
            {tUninstall("keptHasDependents", {
              count: counts.keptHasDependents,
            })}
          </li>
        )}
      </ul>
    </div>
  )
}
