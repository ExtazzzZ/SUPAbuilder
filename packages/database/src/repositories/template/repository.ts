import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  isNull,
  sql,
} from "../../client"
import {
  templateInstallationModel,
  templateModel,
  workspaceModel,
} from "../../schema"
import type { TemplateModel } from "../../types"
import { templateInstallationRepository } from "../template-installation/repository"
import { templateVersionRepository } from "../template-version/repository"

/**
 * What the list page needs: never the multi-MB `payload`, the `selection`
 * blob, or the secrets `shareToken` and `payloadHash` (a list reader is not
 * necessarily allowed to share the template).
 */
export type TemplateListRow = Omit<
  TemplateModel,
  "payload" | "selection" | "shareToken" | "payloadHash"
> & {
  installCount: number
}

type NewTemplate = typeof templateModel.$inferInsert
type TemplateVersionSnapshot = {
  payload: NewTemplate["payload"]
  payloadHash: string
  formatVersion: number
}

const liveWhere = (key: { id: string; workspaceId: string }) =>
  and(
    eq(templateModel.id, key.id),
    eq(templateModel.workspaceId, key.workspaceId),
    isNull(templateModel.deletedAt),
  )

/** Installations that still hold copied resources. Uninstalled and failed rows drop out. */
const ACTIVE_INSTALLATION_STATUSES = ["completed", "partial"] as const

export const templateRepository = {
  /** One live template of a workspace, snapshot included. */
  async findLive(
    key: { id: string; workspaceId: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateModel | undefined> {
    return await tx.query.templateModel.findFirst({
      where: { ...key, deletedAt: { isNull: true as const } },
    })
  },

  /** One live template of a workspace without its (multi-MB) snapshot payload. */
  async findLiveDetail(key: { id: string; workspaceId: string }) {
    return await db.query.templateModel.findFirst({
      where: { ...key, deletedAt: { isNull: true as const } },
      columns: { payload: false },
    })
  },

  /** A live template by id alone, for flows that already authorized the workspace elsewhere. */
  async findLiveById(id: string): Promise<TemplateModel | undefined> {
    return await db.query.templateModel.findFirst({
      where: { id, deletedAt: { isNull: true as const } },
    })
  },

  async findLiveByShareToken(
    shareToken: string,
  ): Promise<TemplateModel | undefined> {
    return await db.query.templateModel.findFirst({
      where: { shareToken, deletedAt: { isNull: true as const } },
    })
  },

  /** What an installation needs from its (still live) source template. */
  async findInstallSource(templateId: string) {
    return await db.query.templateModel.findFirst({
      where: { id: templateId, deletedAt: { isNull: true as const } },
      columns: {
        payload: true,
        name: true,
        createInstallFolder: true,
        categoryCounts: true,
      },
    })
  },

  async rotateShareToken(input: {
    id: string
    workspaceId: string
    shareToken: string
  }): Promise<TemplateModel | undefined> {
    const [row] = await db
      .update(templateModel)
      .set({ shareToken: input.shareToken })
      .where(liveWhere(input))
      .returning()
    return row
  },

  /** `shareExpiresAt` undefined keeps the current expiry; `null` clears it. */
  async updateShareSettings(input: {
    id: string
    workspaceId: string
    shareEnabled: boolean
    shareExpiresAt?: Date | null
  }): Promise<TemplateModel | undefined> {
    const [row] = await db
      .update(templateModel)
      .set({
        shareEnabled: input.shareEnabled,
        shareExpiresAt: input.shareExpiresAt,
      })
      .where(liveWhere(input))
      .returning()
    return row
  },

  /** Inserts a template together with its first version. */
  async createWithFirstVersion(input: {
    values: NewTemplate
    versionId: string
    snapshot: TemplateVersionSnapshot
  }): Promise<TemplateModel> {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(templateModel)
        .values(input.values)
        .returning()
      await templateVersionRepository.insert(
        {
          id: input.versionId,
          templateId: created.id,
          workspaceId: created.workspaceId,
          version: 1,
          ...input.snapshot,
        },
        tx,
      )
      return created
    })
  },

  /**
   * Saves new contents and records the version they produce. The version
   * advances only when the content hash changed; `legacyPayloadHash` stands in
   * for a template saved before hashes were stored. Returns `undefined` when
   * the template is gone.
   */
  async saveWithVersion(input: {
    id: string
    workspaceId: string
    versionId: string
    set: Omit<Partial<NewTemplate>, "version" | "payloadHash">
    snapshot: TemplateVersionSnapshot
    legacyPayloadHash: string | null
  }): Promise<TemplateModel | undefined> {
    const { snapshot } = input
    return await db.transaction(async (tx) => {
      // Pinning and pruning versions share this lock (see the version repository).
      await templateVersionRepository.lockVersions(input.id, tx)
      const [updated] = await tx
        .update(templateModel)
        .set({
          ...input.set,
          payloadHash: snapshot.payloadHash,
          version: sql`CASE WHEN coalesce(${input.legacyPayloadHash}::text, ${templateModel.payloadHash}) IS DISTINCT FROM ${snapshot.payloadHash} THEN ${templateModel.version} + 1 ELSE ${templateModel.version} END`,
        })
        .where(liveWhere(input))
        .returning()
      if (!updated) {
        return
      }
      await templateVersionRepository.insert(
        {
          id: input.versionId,
          templateId: updated.id,
          workspaceId: updated.workspaceId,
          version: updated.version,
          ...snapshot,
        },
        tx,
      )
      await templateVersionRepository.prune(
        { templateId: updated.id, latestVersion: updated.version },
        tx,
      )
      return updated
    })
  },

  /**
   * Soft-deletes a template; its installations are stamped in the same
   * transaction so none stays locked by a template that is gone. `false` when
   * it was already gone.
   */
  async softDelete(key: { id: string; workspaceId: string }): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(templateModel)
        .set({ deletedAt: new Date() })
        .where(liveWhere(key))
        .returning({ id: templateModel.id })
      if (!deleted) {
        return false
      }
      await templateInstallationRepository.markSourceDeleted(key.id, tx)
      return true
    })
  },

  /**
   * A live template's snapshot payload and share state, looked up by link.
   * Callers apply the share/expiry/tenant gates; this only reads.
   */
  async findPayloadByShareToken(shareToken: string) {
    return await db.query.templateModel.findFirst({
      where: { shareToken, deletedAt: { isNull: true as const } },
      columns: { payload: true, shareEnabled: true, shareExpiresAt: true },
    })
  },

  /**
   * The workspace's live templates with their install count, in two queries
   * regardless of how many templates there are: the template rows, then one
   * `GROUP BY` over the `templateId` index for the whole page. The count sums
   * `successfulInstallEvents` over active installations only (a reinstall
   * counts, an auto/manual sync and an uninstalled copy do not).
   */
  async listWithInstallCounts(workspaceId: string): Promise<TemplateListRow[]> {
    const templates = await db.query.templateModel.findMany({
      where: { workspaceId, deletedAt: { isNull: true as const } },
      orderBy: { createdAt: "desc" },
      columns: {
        payload: false,
        selection: false,
        shareToken: false,
        payloadHash: false,
      },
    })
    if (templates.length === 0) {
      return []
    }

    const counts = await db
      .select({
        templateId: templateInstallationModel.templateId,
        installCount: sql<number>`coalesce(sum(${templateInstallationModel.successfulInstallEvents}), 0)::int`,
      })
      .from(templateInstallationModel)
      .where(
        and(
          inArray(
            templateInstallationModel.templateId,
            templates.map((template) => template.id),
          ),
          inArray(templateInstallationModel.status, [
            ...ACTIVE_INSTALLATION_STATUSES,
          ]),
        ),
      )
      .groupBy(templateInstallationModel.templateId)

    const installCountByTemplateId = new Map(
      counts.map(({ templateId, installCount }) => [templateId, installCount]),
    )
    return templates.map((template) => ({
      ...template,
      installCount: installCountByTemplateId.get(template.id) ?? 0,
    }))
  },

  /**
   * Install figures for one template, grouped in the database: how many
   * installations are in each status and how many of the active ones follow
   * auto-update. Aggregates only — no target workspace is ever named.
   */
  async installAnalytics(templateId: string): Promise<{
    byStatus: { status: string; count: number }[]
    activeAutoUpdate: number
    totalInstallEvents: number
    byVersion: { version: number; count: number }[]
  }> {
    const byStatus = await db
      .select({
        status: templateInstallationModel.status,
        count: sql<number>`count(*)::int`,
        autoUpdate: sql<number>`count(*) filter (where ${templateInstallationModel.autoUpdate})::int`,
        events: sql<number>`coalesce(sum(${templateInstallationModel.successfulInstallEvents}), 0)::int`,
      })
      .from(templateInstallationModel)
      .where(eq(templateInstallationModel.templateId, templateId))
      .groupBy(templateInstallationModel.status)

    const byVersion = await db
      .select({
        version: templateInstallationModel.sourceVersion,
        count: sql<number>`count(*)::int`,
      })
      .from(templateInstallationModel)
      .where(
        and(
          eq(templateInstallationModel.templateId, templateId),
          inArray(templateInstallationModel.status, [
            ...ACTIVE_INSTALLATION_STATUSES,
          ]),
        ),
      )
      .groupBy(templateInstallationModel.sourceVersion)
      .orderBy(templateInstallationModel.sourceVersion)

    return {
      byVersion,
      byStatus: byStatus.map(({ status, count }) => ({ status, count })),
      activeAutoUpdate: byStatus
        .filter((row) =>
          (ACTIVE_INSTALLATION_STATUSES as readonly string[]).includes(
            row.status,
          ),
        )
        .reduce((sum, row) => sum + row.autoUpdate, 0),
      totalInstallEvents: byStatus.reduce((sum, row) => sum + row.events, 0),
    }
  },

  /**
   * One page of the workspaces that installed a template, grouped by their
   * opaque `publisherRef`, in a single grouped query. Active means
   * completed/partial: `installCount` sums install events of active copies
   * only (an uninstalled copy drops out), `totalInstallEvents` is history.
   * Keyset on `(lastInstalledAt desc, publisherRef)`; the name is the only
   * thing about the target workspace that is shown.
   */
  async listPublisherRows(input: {
    templateId: string
    search?: string
    after?: { lastInstalledAt: Date; publisherRef: string }
    limit: number
  }): Promise<PublisherInstallationRow[]> {
    const active = sql`${templateInstallationModel.status} IN ('completed', 'partial')`
    // Every installer has a date: a copy that never completed (failed only)
    // falls back to when it was requested. Truncated to the cursor's
    // millisecond precision so rows sharing a boundary are not skipped.
    const lastInstalledAtExpr = sql`date_trunc('milliseconds', coalesce(max(${templateInstallationModel.completedAt}), max(${templateInstallationModel.createdAt})))`
    const lastInstalledAt = sql<Date>`${lastInstalledAtExpr}`
    const rows = await db
      .select({
        publisherRef: templateInstallationModel.publisherRef,
        // Only a workspace that granted it is named; the others stay anonymous.
        workspaceName: sql<
          string | null
        >`min(${workspaceModel.name}) filter (where ${templateInstallationModel.publisherUninstallGrant} > 0)`,
        installCount: sql<number>`coalesce(sum(${templateInstallationModel.successfulInstallEvents}) filter (where ${active}), 0)::int`,
        totalInstallEvents: sql<number>`coalesce(sum(${templateInstallationModel.successfulInstallEvents}), 0)::int`,
        lastInstalledAt,
        oldestVersion: sql<
          number | null
        >`min(${templateInstallationModel.sourceVersion}) filter (where ${active})`,
        autoUpdate: sql<boolean>`coalesce(bool_or(${templateInstallationModel.autoUpdate}) filter (where ${active}), false)`,
        active: sql<boolean>`coalesce(bool_or(${active}), false)`,
        eligibleForUninstall: sql<boolean>`coalesce(bool_and(${templateInstallationModel.publisherUninstallGrant} > 0) filter (where ${active}), false)`,
      })
      .from(templateInstallationModel)
      .innerJoin(
        workspaceModel,
        eq(workspaceModel.id, templateInstallationModel.workspaceId),
      )
      .where(
        and(
          eq(templateInstallationModel.templateId, input.templateId),
          inArray(templateInstallationModel.status, [
            "completed",
            "partial",
            "failed",
            "uninstalled",
          ]),
          input.search
            ? sql`${templateInstallationModel.publisherUninstallGrant} > 0 AND ${workspaceModel.name} ILIKE ${`%${input.search.replace(/[\\%_]/g, "\\$&")}%`}`
            : undefined,
        ),
      )
      .groupBy(templateInstallationModel.publisherRef)
      .having(
        input.after
          ? sql`(${lastInstalledAtExpr}, ${templateInstallationModel.publisherRef}) < (${input.after.lastInstalledAt.toISOString()}::timestamptz, ${input.after.publisherRef})`
          : undefined,
      )
      .orderBy(
        sql`${lastInstalledAtExpr} desc`,
        sql`${templateInstallationModel.publisherRef} desc`,
      )
      .limit(input.limit)
    return rows
  },
}

export type PublisherInstallationRow = {
  publisherRef: string
  /** `null` when the installer did not let the publisher see the workspace. */
  workspaceName: string | null
  installCount: number
  totalInstallEvents: number
  lastInstalledAt: Date | null
  oldestVersion: number | null
  autoUpdate: boolean
  active: boolean
  eligibleForUninstall: boolean
}
