import {
  and,
  asc,
  type DatabaseClient,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "../../client"
import {
  parseTemplateUninstallCounts,
  type TemplateActorKind,
  type TemplateUninstallCounts,
  type TemplateUninstallRequester,
} from "../../partials/template"
import {
  templateInstallationModel,
  templateInstallationSyncModel,
  templateModel,
} from "../../schema"
import type { TemplateInstallationModel } from "../../types"

/** Only the current owner of the lease may write; zero rows means it was fenced out. */
const ownedByClaim = (input: { id: string; claimToken: string }) =>
  and(
    eq(templateInstallationModel.id, input.id),
    eq(templateInstallationModel.status, "installing"),
    eq(templateInstallationModel.claimToken, input.claimToken),
  )

/** `pending` for too long (never enqueued, or the job was lost) or `installing` past its lease. */
const unfinishedInstallation = (input: {
  pendingBefore: Date
  leaseExpiredBefore: Date
}) =>
  or(
    and(
      eq(templateInstallationModel.status, "pending"),
      lt(templateInstallationModel.createdAt, input.pendingBefore),
    ),
    and(
      eq(templateInstallationModel.status, "installing"),
      lt(templateInstallationModel.claimedAt, input.leaseExpiredBefore),
    ),
  )

/** A sync of this installation is queued or running. */
const hasActiveSync = () =>
  sql<boolean>`EXISTS (SELECT 1 FROM ${templateInstallationSyncModel} WHERE ${templateInstallationSyncModel.installationId} = ${templateInstallationModel.id} AND ${templateInstallationSyncModel.status} IN ('pending', 'running'))`

/** The columns the installs list renders — never `errorMessage`, `warnings` or `permissions`. */
export type TemplateInstallationPageRow = Pick<
  TemplateInstallationModel,
  | "id"
  | "templateName"
  | "status"
  | "errorCode"
  | "resourceCount"
  | "warningCount"
  | "createdAt"
  | "completedAt"
  | "autoUpdate"
  | "uninstalledByKind"
> & {
  activeSync: boolean
  /** The source template is newer than the installed version; false when the template was deleted. */
  updateAvailable: boolean
  /** Normalised (pre-`keptHasDependents` rows read as 0); null unless uninstalled. */
  uninstallCounts: TemplateUninstallCounts | null
}

export type StaleTemplateInstallationRow = {
  id: string
  workspaceId: string
}

const findNewestBySourceTemplate = async (
  input: { workspaceId: string; sourceTemplateId: string },
  statuses: TemplateInstallationModel["status"][],
  tx: DatabaseClient,
): Promise<TemplateInstallationModel | null> => {
  const [row] = await tx
    .select()
    .from(templateInstallationModel)
    .where(
      and(
        eq(templateInstallationModel.workspaceId, input.workspaceId),
        eq(templateInstallationModel.sourceTemplateId, input.sourceTemplateId),
        inArray(templateInstallationModel.status, statuses),
      ),
    )
    .orderBy(desc(templateInstallationModel.id))
    .limit(1)
  return row ?? null
}

export const templateInstallationRepository = {
  /**
   * Serialises install requests for one (workspace, template) pair for the
   * rest of the transaction, so the "latest install" read below cannot race a
   * concurrent request. The partial unique index is the backstop.
   */
  async lockInstallRequest(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient,
  ): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tpl-install:${input.workspaceId}:${input.sourceTemplateId}`}, 0))`,
    )
  },

  /** The `publisherRef` earlier installations of this pair already carry, if any. */
  async findPublisherRef(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient = db,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ publisherRef: templateInstallationModel.publisherRef })
      .from(templateInstallationModel)
      .where(
        and(
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          eq(
            templateInstallationModel.sourceTemplateId,
            input.sourceTemplateId,
          ),
          sql`${templateInstallationModel.publisherRef} <> ''`,
        ),
      )
      .limit(1)
    return row?.publisherRef ?? null
  },

  /**
   * Which of the given workspaces already hold an installed copy of the
   * template behind a share token: `workspaceId -> newest active installation
   * id`, in one query. Lets the install page offer "update" instead of a
   * second copy without a lookup per workspace.
   */
  async listInstalledByShareToken(
    input: { shareToken: string; workspaceIds: string[] },
    tx: DatabaseClient = db,
  ): Promise<
    Map<string, { id: string; granted: boolean; autoUpdate: boolean }>
  > {
    if (input.workspaceIds.length === 0) {
      return new Map()
    }
    const rows = await tx
      .select({
        workspaceId: templateInstallationModel.workspaceId,
        id: sql<string>`max(${templateInstallationModel.id})`,
        granted: sql<boolean>`coalesce(bool_or(${templateInstallationModel.publisherUninstallGrant} > 0), false)`,
        autoUpdate: sql<boolean>`coalesce(bool_or(${templateInstallationModel.autoUpdate}), false)`,
      })
      .from(templateInstallationModel)
      .innerJoin(
        templateModel,
        eq(templateModel.id, templateInstallationModel.sourceTemplateId),
      )
      .where(
        and(
          eq(templateModel.shareToken, input.shareToken),
          inArray(templateInstallationModel.workspaceId, input.workspaceIds),
          inArray(templateInstallationModel.status, ["completed", "partial"]),
        ),
      )
      .groupBy(templateInstallationModel.workspaceId)
    return new Map(
      rows.map((row) => [
        row.workspaceId,
        { id: row.id, granted: row.granted, autoUpdate: row.autoUpdate },
      ]),
    )
  },

  /** The consent the installer's earlier installations of this pair carry (newest row), if any. */
  async findPublisherUninstallGrant(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient = db,
  ): Promise<number | null> {
    const [row] = await tx
      .select({ grant: templateInstallationModel.publisherUninstallGrant })
      .from(templateInstallationModel)
      .where(
        and(
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          eq(
            templateInstallationModel.sourceTemplateId,
            input.sourceTemplateId,
          ),
        ),
      )
      .orderBy(desc(templateInstallationModel.id))
      .limit(1)
    return row?.grant ?? null
  },

  /** Counts a reinstall as an install event (auto and manual syncs are not). */
  async recordInstallEvent(
    installationId: string,
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx
      .update(templateInstallationModel)
      .set({
        successfulInstallEvents: sql`${templateInstallationModel.successfulInstallEvents} + 1`,
      })
      .where(eq(templateInstallationModel.id, installationId))
  },

  /**
   * Marks the installation uninstalled in the caller's transaction. Only an
   * active (completed/partial) row moves; `false` means it already did.
   */
  async markUninstalled(
    input: {
      id: string
      requestedBy: TemplateUninstallRequester
      counts: TemplateUninstallCounts
    },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({
        status: "uninstalled",
        autoUpdate: false,
        uninstalledAt: new Date(),
        uninstalledByKind: input.requestedBy,
        uninstallCounts: input.counts,
      })
      .where(
        and(
          eq(templateInstallationModel.id, input.id),
          inArray(templateInstallationModel.status, ["completed", "partial"]),
        ),
      )
      .returning({ id: templateInstallationModel.id })
    return rows.length > 0
  },

  /** The active installations of one installer (a `publisherRef`) of a template. */
  async listActiveByPublisherRef(
    input: { templateId: string; publisherRef: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel[]> {
    return await tx
      .select()
      .from(templateInstallationModel)
      .where(
        and(
          eq(templateInstallationModel.templateId, input.templateId),
          eq(templateInstallationModel.publisherRef, input.publisherRef),
          inArray(templateInstallationModel.status, ["completed", "partial"]),
        ),
      )
  },

  /**
   * The installer's choice to let the publisher see this workspace and
   * uninstall the template. It belongs to the installer, not to one copy: it
   * is written to every installation of the (workspace, template) pair, so an
   * older copy can never keep a consent the installer has withdrawn.
   */
  async setPublisherUninstallGrant(
    input: { workspaceId: string; sourceTemplateId: string; granted: boolean },
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx
      .update(templateInstallationModel)
      .set({ publisherUninstallGrant: input.granted ? 1 : 0 })
      .where(
        and(
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          eq(
            templateInstallationModel.sourceTemplateId,
            input.sourceTemplateId,
          ),
        ),
      )
  },

  /** The newest installation of a template into a workspace, whatever its status. */
  async findLatestBySourceTemplate(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    const [row] = await tx
      .select()
      .from(templateInstallationModel)
      .where(
        and(
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          eq(
            templateInstallationModel.sourceTemplateId,
            input.sourceTemplateId,
          ),
        ),
      )
      .orderBy(desc(templateInstallationModel.id))
      .limit(1)
    return row ?? null
  },

  /** The install of a template into a workspace that is still in flight, if any. */
  async findActiveBySourceTemplate(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    return await findNewestBySourceTemplate(
      input,
      ["pending", "installing"],
      tx,
    )
  },

  /** The newest installed (`completed` / `partial`) copy of a template in a workspace, if any. */
  async findInstalledBySourceTemplate(
    input: { workspaceId: string; sourceTemplateId: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    return await findNewestBySourceTemplate(input, ["completed", "partial"], tx)
  },

  async create(
    values: typeof templateInstallationModel.$inferInsert,
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel> {
    const [row] = await tx
      .insert(templateInstallationModel)
      .values(values)
      .returning()
    return row
  },

  async findByIdAndWorkspace(
    input: { id: string; workspaceId: string },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    const row = await tx.query.templateInstallationModel.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
    })
    return row ?? null
  },

  /**
   * `failed` → `pending` for a manual retry; the claim and the previous
   * failure are cleared. Zero rows means the installation was not `failed`.
   */
  async resetFailed(
    input: {
      id: string
      workspaceId: string
      /** Whoever retries becomes the installer the worker authorizes. */
      installedBy: string | null
      installedByKind: TemplateActorKind
      /** Re-pins the retry to this template version; absent keeps the pinned one. */
      sourceVersion?: number
    },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    const [row] = await tx
      .update(templateInstallationModel)
      .set({
        ...(input.sourceVersion === undefined
          ? {}
          : { sourceVersion: input.sourceVersion }),
        status: "pending",
        claimToken: null,
        claimedAt: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        installedBy: input.installedBy,
        installedByKind: input.installedByKind,
        // The retry restarts the install clock the redispatch sweep and the
        // abandon cutoff measure from.
        createdAt: new Date(),
      })
      .where(
        and(
          eq(templateInstallationModel.id, input.id),
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          eq(templateInstallationModel.status, "failed"),
        ),
      )
      .returning()
    return row ?? null
  },
  /**
   * Stamps every installation of a deleted template, so the locks it put on
   * installed copies stop applying and auto-update stops. Idempotent: rows
   * already stamped keep their original time.
   */
  async markSourceDeleted(
    sourceTemplateId: string,
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx
      .update(templateInstallationModel)
      .set({ sourceDeletedAt: new Date() })
      .where(
        and(
          eq(templateInstallationModel.sourceTemplateId, sourceTemplateId),
          isNull(templateInstallationModel.sourceDeletedAt),
        ),
      )
  },

  /**
   * Keyset page over `id` descending. Ids are Snowflakes, so they grow with
   * creation time: one column gives newest-first order with no timestamp
   * precision to lose in the cursor. Fetches `limit + 1` so the caller can
   * tell whether another page exists without a count query.
   */
  async listPage(
    input: {
      workspaceId: string
      status?: TemplateInstallationModel["status"]
      /** Only installs still in flight: `pending` / `installing`, or with an active sync. */
      activeOnly?: boolean
      beforeId?: string
      limit: number
    },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationPageRow[]> {
    const rows = await tx
      .select({
        id: templateInstallationModel.id,
        templateName: templateInstallationModel.templateName,
        status: templateInstallationModel.status,
        errorCode: templateInstallationModel.errorCode,
        resourceCount: templateInstallationModel.resourceCount,
        warningCount: templateInstallationModel.warningCount,
        createdAt: templateInstallationModel.createdAt,
        completedAt: templateInstallationModel.completedAt,
        autoUpdate: templateInstallationModel.autoUpdate,
        activeSync: hasActiveSync(),
        uninstalledByKind: templateInstallationModel.uninstalledByKind,
        rawUninstallCounts: templateInstallationModel.uninstallCounts,
        // NULL template (hard-deleted source) compares to NULL -> false.
        updateAvailable: sql<boolean>`COALESCE(${templateInstallationModel.sourceVersion} < ${templateModel.version}, false)`,
      })
      .from(templateInstallationModel)
      .leftJoin(
        templateModel,
        eq(templateModel.id, templateInstallationModel.templateId),
      )
      .where(
        and(
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          input.status
            ? eq(templateInstallationModel.status, input.status)
            : undefined,
          input.activeOnly
            ? or(
                inArray(templateInstallationModel.status, [
                  "pending",
                  "installing",
                ]),
                hasActiveSync(),
              )
            : undefined,
          input.beforeId
            ? lt(templateInstallationModel.id, input.beforeId)
            : undefined,
        ),
      )
      .orderBy(desc(templateInstallationModel.id))
      .limit(input.limit + 1)
    return rows.map(({ rawUninstallCounts, ...row }) => ({
      ...row,
      uninstallCounts: parseTemplateUninstallCounts(rawUninstallCounts),
    }))
  },

  /**
   * Takes ownership of an installation in one statement: a `pending` row, or
   * an `installing` row whose lease expired. Whoever gets the row back owns
   * it; every other call (a redelivery, a second worker) returns `null`.
   */
  async claim(
    input: {
      id: string
      workspaceId: string
      claimToken: string
      leaseExpiredBefore: Date
    },
    tx: DatabaseClient = db,
  ): Promise<TemplateInstallationModel | null> {
    const [row] = await tx
      .update(templateInstallationModel)
      .set({
        status: "installing",
        claimToken: input.claimToken,
        claimedAt: new Date(),
        attempts: sql`${templateInstallationModel.attempts} + 1`,
      })
      .where(
        and(
          eq(templateInstallationModel.id, input.id),
          eq(templateInstallationModel.workspaceId, input.workspaceId),
          or(
            eq(templateInstallationModel.status, "pending"),
            and(
              eq(templateInstallationModel.status, "installing"),
              lt(templateInstallationModel.claimedAt, input.leaseExpiredBefore),
            ),
          ),
        ),
      )
      .returning()
    return row ?? null
  },

  /** Gives the installation back (`installing` → `pending`) before a retryable failure. */
  async release(
    input: { id: string; claimToken: string },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({ status: "pending", claimToken: null, claimedAt: null })
      .where(ownedByClaim(input))
      .returning({ id: templateInstallationModel.id })
    return rows.length > 0
  },

  /** Terminal success, written inside the apply transaction and fenced by the lease. */
  async complete(
    input: {
      id: string
      claimToken: string
      completion: Pick<
        typeof templateInstallationModel.$inferInsert,
        | "status"
        | "warnings"
        | "warningCount"
        | "resourceCount"
        | "installFolderId"
      >
    },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({
        ...input.completion,
        claimToken: null,
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(),
        successfulInstallEvents: 1,
      })
      .where(ownedByClaim(input))
      .returning({ id: templateInstallationModel.id })
    return rows.length > 0
  },

  /** Terminal failure by the lease owner, written outside the rolled-back apply transaction. */
  async fail(
    input: {
      id: string
      claimToken: string
      errorCode: string
      errorMessage: string
    },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        claimToken: null,
        completedAt: new Date(),
      })
      .where(ownedByClaim(input))
      .returning({ id: templateInstallationModel.id })
    return rows.length > 0
  },

  /**
   * Fails a row nobody owns (the enqueue itself threw, or the owner is
   * blocked), so it never stays `pending` for the sweep to re-find.
   */
  async failUnclaimed(
    input: { id: string; errorCode: string; errorMessage: string },
    tx: DatabaseClient = db,
  ): Promise<boolean> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        claimToken: null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(templateInstallationModel.id, input.id),
          or(
            eq(templateInstallationModel.status, "pending"),
            eq(templateInstallationModel.status, "installing"),
          ),
        ),
      )
      .returning({ id: templateInstallationModel.id })
    return rows.length > 0
  },

  /**
   * Installations the worker never finished and that are still worth
   * retrying: younger than `createdAfter`, so one that can never succeed is
   * not re-enqueued forever.
   */
  async listStale(
    input: {
      pendingBefore: Date
      leaseExpiredBefore: Date
      createdAfter: Date
      limit: number
    },
    tx: DatabaseClient = db,
  ): Promise<StaleTemplateInstallationRow[]> {
    return await tx
      .select({
        id: templateInstallationModel.id,
        workspaceId: templateInstallationModel.workspaceId,
      })
      .from(templateInstallationModel)
      .where(
        and(
          gt(templateInstallationModel.createdAt, input.createdAfter),
          unfinishedInstallation(input),
        ),
      )
      .orderBy(asc(templateInstallationModel.createdAt))
      .limit(input.limit)
  },

  /** Closes unfinished installations older than `createdBefore` as `failed`. Returns how many. */
  async failAbandoned(
    input: {
      createdBefore: Date
      pendingBefore: Date
      leaseExpiredBefore: Date
      errorCode: string
      errorMessage: string
    },
    tx: DatabaseClient = db,
  ): Promise<number> {
    const rows = await tx
      .update(templateInstallationModel)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        claimToken: null,
        completedAt: new Date(),
      })
      .where(
        and(
          lt(templateInstallationModel.createdAt, input.createdBefore),
          unfinishedInstallation(input),
        ),
      )
      .returning({ id: templateInstallationModel.id })
    return rows.length
  },
}
