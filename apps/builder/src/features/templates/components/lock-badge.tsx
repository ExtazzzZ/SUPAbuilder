"use client"

import type { TemplateResourceKind } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useQuery } from "@tanstack/react-query"
import { LockIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { createContext, type ReactNode, useContext, useMemo } from "react"
import { orpc } from "@/lib/orpc/query"

const NO_LOCKS: ReadonlySet<string> = new Set()
const LockedIdsContext = createContext<ReadonlySet<string>>(NO_LOCKS)

type LockedIdsProviderProps = {
  workspaceId: string
  resourceKind: TemplateResourceKind
  /** The ids on the current list page. */
  resourceIds: readonly string[]
  children: ReactNode
}

/**
 * Fetches, with one request for the whole list page, which of its rows came
 * from a View-only template, and shares the answer with every `LockBadge`
 * underneath. A failed lookup shows no badges: the write paths refuse locked
 * edits on their own, so the badge is only a courtesy.
 */
export function LockedIdsProvider({
  workspaceId,
  resourceKind,
  resourceIds,
  children,
}: LockedIdsProviderProps) {
  const { data } = useQuery({
    ...orpc.templatesAPI.listLockedIdsAPI.queryOptions({
      input: { workspaceId, resourceKind, resourceIds: [...resourceIds] },
    }),
    enabled: resourceIds.length > 0,
    retry: false,
  })
  const lockedIds = useMemo(
    () => (data ? new Set(data.lockedIds) : NO_LOCKS),
    [data],
  )
  return (
    <LockedIdsContext.Provider value={lockedIds}>
      {children}
    </LockedIdsContext.Provider>
  )
}

/** "View only" marker for a row installed from a View-only template. */
export function LockBadge({ resourceId }: { resourceId: string }) {
  const t = useTranslations("templates.locked")
  const lockedIds = useContext(LockedIdsContext)
  if (!lockedIds.has(resourceId)) {
    return null
  }
  return (
    <Badge
      className="ms-2 shrink-0 gap-1"
      title={t("badgeHint")}
      variant="outline"
    >
      <LockIcon aria-hidden="true" className="size-3" />
      {t("badge")}
    </Badge>
  )
}
