import {
  TEMPLATE_MANAGE_PERMISSION,
  templateService,
} from "@chatbotx.io/business"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { buttonVariants } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { getIdFromParams } from "@chatbotx.io/utils"
import { format } from "date-fns"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { InstallerUninstallButton } from "@/features/templates/components/installer-uninstall-button"
import { InstallsByVersion } from "@/features/templates/components/installs-by-version"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"

/**
 * Who installed one of this workspace's templates: one row per installer
 * workspace, showing only its name. Ids never reach the page; the cursor and
 * the row reference are opaque.
 */
export default async function TemplateInstallersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; id: string }>
  searchParams: Promise<{ q?: string; cursor?: string }>
}) {
  const resolvedParams = await params
  const workspaceId = getIdFromParams(resolvedParams, "workspaceId")
  const templateId = getIdFromParams(resolvedParams, "id")
  if (!(workspaceId && templateId)) {
    return notFound()
  }
  await requireWorkspacePermission(workspaceId, TEMPLATE_MANAGE_PERMISSION)
  const userAndWorkspace = await getCurrentUserAndTargetWorkspace(workspaceId)
  if (!userAndWorkspace) {
    return notFound()
  }

  const { q, cursor } = await searchParams
  const actor = {
    kind: "member" as const,
    permissions: userAndWorkspace.targetWorkspaceMember.permissions,
  }
  const [template, installers, analytics] = await Promise.all([
    templateService
      .getDetailOrFail({ workspaceId, templateId })
      .catch(() => null),
    templateService
      .listPublisherInstallations({
        workspaceId,
        templateId,
        actor,
        search: q,
        cursor,
      })
      .catch(() => null),
    templateService
      .getInstallAnalytics({ workspaceId, templateId, actor })
      .catch(() => null),
  ])
  if (!template) {
    return notFound()
  }

  const t = await getTranslations()
  const base = `/space/${workspaceId}/templates/${templateId}/installers`

  return (
    <div className="flex flex-col gap-4">
      <AppBreadcrumb
        items={[
          { label: t("tools.title"), href: `/space/${workspaceId}/tools` },
          {
            label: t("templates.title"),
            href: `/space/${workspaceId}/templates`,
          },
          { label: template.name, href: "" },
          { label: t("templates.installers.title"), href: "" },
        ]}
      />
      {analytics ? (
        <InstallsByVersion
          byVersion={analytics.byVersion}
          currentVersion={template.version}
        />
      ) : null}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t("templates.installers.title")}</CardTitle>
          <form action={base} className="flex items-center gap-2" method="get">
            <input
              aria-label={t("actions.search")}
              className="h-8 w-56 rounded-md border bg-transparent px-2 text-sm"
              defaultValue={q ?? ""}
              name="q"
              placeholder={t("actions.search")}
              type="search"
            />
            <button
              className={buttonVariants({ size: "sm", variant: "outline" })}
              type="submit"
            >
              {t("actions.search")}
            </button>
          </form>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {installers === null ? (
            <p
              className="py-6 text-center text-destructive text-sm"
              role="alert"
            >
              {t("templates.installers.loadError")}
            </p>
          ) : null}
          {installers?.items.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">
              {t("actions.noRecordFound")}
            </p>
          ) : null}
          {installers && installers.items.length > 0 ? (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.workspace")}
                  </th>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.installs")}
                  </th>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.totalInstallEvents")}
                  </th>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.lastInstalled")}
                  </th>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.version")}
                  </th>
                  <th className="py-2 pr-4 font-normal">
                    {t("templates.installers.autoUpdate")}
                  </th>
                  <th className="py-2 font-normal">
                    <span className="sr-only">{t("actions.openMenu")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {installers.items.map((row) => (
                  <tr key={row.publisherRef}>
                    <td className="py-2 pr-4 font-medium">
                      {row.workspaceName ?? t("templates.installers.hidden")}
                      {row.active ? null : (
                        <Badge className="ml-2" variant="secondary">
                          {t("templates.installers.uninstalled")}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {row.installCount}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {row.totalInstallEvents}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {row.lastInstalledAt
                        ? format(row.lastInstalledAt, "yyyy/MM/dd HH:mm")
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {row.oldestVersion === null ? (
                        "—"
                      ) : (
                        <>
                          v{row.oldestVersion}
                          {row.oldestVersion < template.version ? (
                            <Badge className="ml-2">
                              {t("templates.sync.updateAvailable")}
                            </Badge>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {row.autoUpdate
                        ? t("templates.installs.autoUpdateOn")
                        : t("templates.installs.autoUpdateOff")}
                    </td>
                    <td className="py-2 text-right">
                      {row.active ? (
                        <InstallerUninstallButton
                          disabled={!row.eligibleForUninstall}
                          publisherRef={row.publisherRef}
                          templateId={templateId}
                          workspaceId={workspaceId}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {installers?.nextCursor ? (
            <div className="flex justify-end pt-3">
              <Link
                className={buttonVariants({ size: "sm", variant: "outline" })}
                href={`${base}?${new URLSearchParams({ ...(q ? { q } : {}), cursor: installers.nextCursor })}`}
              >
                {t("templates.installs.loadMore")}
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
