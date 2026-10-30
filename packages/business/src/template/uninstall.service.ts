import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type {
  TemplateResourceCategory,
  TemplateResourceKind,
  TemplateUninstallCounts,
  TemplateUninstallRequester,
} from "@chatbotx.io/database/partials"
import {
  templateInstallationRepository,
  templateInstallationSyncRepository,
  templateUninstallRepository,
} from "@chatbotx.io/database/repositories"
import { setLocalStatementTimeout } from "@chatbotx.io/database/statement-timeout"
import { automatedResponseService } from "../automated-response/service"
import { ChatbotXException, notFoundException } from "../errors"
import { resolveWorkspaceFreezeReasonById } from "../workspace-lifecycle/with-blocked-owner-guard"
import { SHARED_KINDS } from "./adapters/manifests/kinds"
import { getTemplateAdapter } from "./adapters/registry"
import { hashCanonical } from "./payload-hash"
import {
  assertCanManageTemplates,
  assertCanUseTemplateCategories,
  assertCanWriteTemplateInstalls,
  type TemplateActor,
} from "./permissions"
import {
  acquireTemplateResourceLocks,
  withTemplateLockedTransaction,
} from "./template-resource-locks"
import { emptyUninstallCounts as emptyCounts } from "./uninstall-summary"

const TEMPLATE_UNINSTALL_STATEMENT_TIMEOUT = "60s"

/**
 * DECISION TABLE (conservative uninstall, synchronous, one transaction per
 * installation). Per copy the installation created:
 * - shared kinds (tags, fields, folders, ...)          -> kept, `keptShared`
 * - kinds other things point at (flows, triggers, ...) -> kept, `keptByPolicy`
 * - keyword, edited or no baseline hash                -> kept, `keptModified`
 * - keyword, still referenced by a contact filter or an
 *   ads conversion rule                                -> kept, `keptHasDependents`
 * - keyword locked against deletion by ANOTHER
 *   installation                                       -> kept, `keptShared`
 * - keyword, unmodified and unreferenced               -> deleted
 * Every governed copy is detached, so no lock outlives the uninstall. Folders
 * an install created are always kept (they are shared kinds). Nothing here is
 * queued: no worker, no operation table.
 */
const DELETABLE_KINDS: ReadonlySet<TemplateResourceKind> =
  new Set<TemplateResourceKind>(["automatedResponse"])

type Installation = NonNullable<
  Awaited<
    ReturnType<typeof templateInstallationRepository.findByIdAndWorkspace>
  >
>
type InstalledRow = Awaited<
  ReturnType<typeof templateInstallationSyncRepository.listInstalledResources>
>[number]

export type TemplateUninstallFailure = { installationId: string; code: string }

/** `done + failures.length === installations`; a retry completes the failed ones. */
export type TemplateUninstallPublisherResult = {
  installations: number
  counts: TemplateUninstallCounts
  done: number
  failures: TemplateUninstallFailure[]
}

const uninstallInProgressException = () =>
  new ChatbotXException(
    "A sync of this installation is in progress",
    "templateUninstallInProgress",
    409,
  )

const notGrantedException = () =>
  new ChatbotXException(
    "The installer did not allow this template to be uninstalled by its publisher",
    "templateUninstallNotGranted",
    403,
  )

const targetBlockedException = () =>
  new ChatbotXException(
    "The installer's workspace is frozen, so the template can not be uninstalled right now",
    "templateUninstallTargetBlocked",
    409,
  )

type Decision = {
  counts: TemplateUninstallCounts
  /** Installed-resource rows of keywords to delete, with the `type` read from the locked row. */
  toDelete: { row: InstalledRow; type: "inbound" | "outbound" }[]
  /** Everything the installation created and still governs: detached afterwards. */
  governedRowIds: string[]
}

/**
 * Decides, for one installation, what happens to each copy it created.
 * Read-only: shared by the preview and the execution, so what the preview
 * promises is what the execution decides (it re-decides under the lock).
 */
const decide = async (
  tx: DatabaseClient,
  installation: Installation,
  rows: InstalledRow[],
): Promise<Decision> => {
  const counts = emptyCounts()
  const candidates: InstalledRow[] = []

  // Lock the keyword rows before reading them: an edit racing this uninstall
  // waits, then updates 0 rows (deleted) or a detached copy (kept).
  const types = await templateUninstallRepository.lockKeywords(
    {
      workspaceId: installation.workspaceId,
      ids: rows
        .filter((row) => DELETABLE_KINDS.has(row.resourceKind))
        .map((row) => row.resourceId),
    },
    tx,
  )

  for (const row of rows) {
    if (SHARED_KINDS.has(row.resourceKind)) {
      counts.keptShared++
      continue
    }
    const handler = getTemplateAdapter(
      row.category as TemplateResourceCategory,
    )?.sync
    if (!(DELETABLE_KINDS.has(row.resourceKind) && handler)) {
      counts.keptByPolicy++
      continue
    }
    const current = await handler.project(tx, row.resourceId)
    if (current === null || !types.has(row.resourceId)) {
      // Already gone (the installer deleted it): nothing to do, nothing to count.
      continue
    }
    const unmodified =
      row.syncedHash !== null &&
      (await hashCanonical(current)) === row.syncedHash
    if (!unmodified) {
      counts.keptModified++
      continue
    }
    candidates.push(row)
  }

  const ids = candidates.map((row) => row.resourceId)
  const [referenced, lockedByOthers] = await Promise.all([
    templateUninstallRepository.findReferencedKeywordIds(
      { workspaceId: installation.workspaceId, ids },
      tx,
    ),
    // Only installations OTHER than this one can still lock a keyword.
    templateUninstallRepository.findDeleteBlockedByOthers(
      {
        workspaceId: installation.workspaceId,
        resourceKind: "automatedResponse",
        resourceIds: ids,
        excludeInstallationIds: [installation.id],
      },
      tx,
    ),
  ])
  const toDelete: Decision["toDelete"] = []
  for (const row of candidates) {
    const type = types.get(row.resourceId)
    if (referenced.has(row.resourceId)) {
      // Kept and detached: a contact filter or ads rule points at it.
      counts.keptHasDependents++
      continue
    }
    if (!type || lockedByOthers.has(row.resourceId)) {
      // Kept and detached: another installation still locks it.
      counts.keptShared++
      continue
    }
    counts.deleted++
    toDelete.push({ row, type })
  }
  return { counts, toDelete, governedRowIds: rows.map((row) => row.id) }
}

const assertUninstallable = async (
  tx: DatabaseClient,
  installation: Installation | null,
  workspaceId: string,
): Promise<Installation> => {
  if (
    !installation ||
    installation.workspaceId !== workspaceId ||
    !["completed", "partial"].includes(installation.status)
  ) {
    throw notFoundException("Template installation not found")
  }
  // A queued sync is cancelled by the uninstall; only a running one blocks it.
  if (await templateUninstallRepository.hasRunningSync(installation.id, tx)) {
    throw uninstallInProgressException()
  }
  return installation
}

const sumCounts = (
  total: TemplateUninstallCounts,
  next: TemplateUninstallCounts,
): TemplateUninstallCounts => ({
  deleted: total.deleted + next.deleted,
  keptModified: total.keptModified + next.keptModified,
  keptShared: total.keptShared + next.keptShared,
  keptByPolicy: total.keptByPolicy + next.keptByPolicy,
  keptHasDependents: total.keptHasDependents + next.keptHasDependents,
})

/** Preview or execute one installation, in its own transaction under the install lock. */
const processInstallation = async (input: {
  installationId: string
  workspaceId: string
  requestedBy: TemplateUninstallRequester
  actor?: TemplateActor
  /** A publisher-side run must find the installer's consent on the row it reads under the lock. */
  requireGrant?: boolean
  dryRun: boolean
}): Promise<TemplateUninstallCounts> => {
  if (input.requestedBy === "publisher" && !input.dryRun) {
    // A publisher must not act on a frozen workspace (blocked owner, scheduled
    // deletion). The installer's own uninstall stays allowed: invariant 14.
    const { freezeReason } = await resolveWorkspaceFreezeReasonById(
      input.workspaceId,
    )
    if (freezeReason) {
      throw targetBlockedException()
    }
  }
  const outcome = await withTemplateLockedTransaction(
    async (tx) => {
      const installation = await assertUninstallable(
        tx,
        await templateInstallationRepository.findByIdAndWorkspace(
          { id: input.installationId, workspaceId: input.workspaceId },
          tx,
        ),
        input.workspaceId,
      )
      if (input.requireGrant && installation.publisherUninstallGrant <= 0) {
        throw notGrantedException()
      }
      const governed = (
        await templateInstallationSyncRepository.listInstalledResources(
          installation.id,
          tx,
        )
      ).filter((row) => !(row.wasExisting || row.detachedAt))
      if (!input.dryRun) {
        // Same sorted-lock protocol as local editors and sync: take every
        // governed copy's lock before reading or fingerprinting any of them.
        await acquireTemplateResourceLocks(
          tx,
          governed.map((row) => ({
            kind: row.resourceKind,
            resourceId: row.resourceId,
          })),
        )
      }
      const decision = await decide(tx, installation, governed)
      // A preview only reads, so it asks for no category permission.
      if (input.actor && !input.dryRun) {
        // Writing needs `flows` (the manage permission) plus the permission of everything it touches.
        assertCanManageTemplates(input.actor)
        const categories = Object.fromEntries(
          (
            await templateInstallationSyncRepository.listInstalledResources(
              installation.id,
              tx,
            )
          ).map((row) => [row.category, 1]),
        )
        assertCanUseTemplateCategories(input.actor, categories)
      }
      if (input.dryRun) {
        return { counts: decision.counts, deletedKeywords: false }
      }

      // Detach first, then delete: the copies stop being governed by the
      // template, so nothing it locked stays locked behind an uninstalled install.
      await templateInstallationSyncRepository.detachResources(
        decision.governedRowIds,
        tx,
      )
      await templateUninstallRepository.cancelPendingSyncs(installation.id, tx)
      // Deleted through the service (the single delete implementation), per
      // `type` read from the locked row. The other installations' locks are
      // re-checked there; this installation's own were just detached.
      for (const type of ["inbound", "outbound"] as const) {
        const ids = decision.toDelete
          .filter((entry) => entry.type === type)
          .map((entry) => entry.row.resourceId)
        if (ids.length > 0) {
          await automatedResponseService.deleteMany(
            installation.workspaceId,
            ids,
            type,
            tx,
            { excludeInstallationIds: [installation.id] },
          )
        }
      }
      const moved = await templateInstallationRepository.markUninstalled(
        {
          id: installation.id,
          requestedBy: input.requestedBy,
          counts: decision.counts,
        },
        tx,
      )
      if (!moved) {
        throw uninstallInProgressException()
      }
      return {
        counts: decision.counts,
        deletedKeywords: decision.toDelete.length > 0,
      }
    },
    {
      // The install-request lock always precedes the per-resource locks.
      prepare: async (tx) => {
        await setLocalStatementTimeout(tx, TEMPLATE_UNINSTALL_STATEMENT_TIMEOUT)
        const probe = await templateInstallationRepository.findByIdAndWorkspace(
          { id: input.installationId, workspaceId: input.workspaceId },
          tx,
        )
        if (probe?.sourceTemplateId) {
          // Excludes a concurrent install request, sync or restore of the pair.
          await templateInstallationRepository.lockInstallRequest(
            {
              workspaceId: input.workspaceId,
              sourceTemplateId: probe.sourceTemplateId,
            },
            tx,
          )
        }
      },
    },
  )
  if (outcome.deletedKeywords) {
    await automatedResponseService.invalidateCache(input.workspaceId)
  }
  return outcome.counts
}

/**
 * Uninstalling a template from a workspace. Conservative by design: it
 * deletes only unmodified copies of leaf kinds (today keywords) and keeps
 * everything else, releasing every lock. The copies the installer edited,
 * shared tags and fields, and anything other things point at are never
 * destroyed.
 */
export const templateUninstallService = {
  /** What an installer-side uninstall would do, without doing it. */
  async previewAsInstaller(input: {
    workspaceId: string
    installationId: string
    actor: TemplateActor
  }): Promise<TemplateUninstallCounts> {
    // A preview only reads, so a read-only token may ask.
    return await processInstallation({
      ...input,
      requestedBy: "installer",
      dryRun: true,
    })
  },

  async uninstallAsInstaller(input: {
    workspaceId: string
    installationId: string
    actor: TemplateActor
  }): Promise<TemplateUninstallCounts> {
    assertCanWriteTemplateInstalls(input.actor)
    return await processInstallation({
      ...input,
      requestedBy: "installer",
      dryRun: false,
    })
  },

  /** What a publisher-side uninstall of one installer would do, without doing it. */
  async previewAsPublisher(input: {
    workspaceId: string
    templateId: string
    publisherRef: string
    actor: TemplateActor
  }): Promise<TemplateUninstallPublisherResult> {
    return await runAsPublisher({ ...input, dryRun: true })
  },

  /**
   * The publisher removes their template from one installer's workspace.
   * Allowed only for installations whose installer granted it, and only from
   * the workspace that owns the template; the same keep-what-matters rules
   * apply.
   */
  async uninstallAsPublisher(input: {
    workspaceId: string
    templateId: string
    publisherRef: string
    actor: TemplateActor
  }): Promise<TemplateUninstallPublisherResult> {
    return await runAsPublisher({ ...input, dryRun: false })
  },
}

const runAsPublisher = async (input: {
  workspaceId: string
  templateId: string
  publisherRef: string
  actor: TemplateActor
  dryRun: boolean
}): Promise<TemplateUninstallPublisherResult> => {
  assertCanManageTemplates(input.actor)
  if (!input.dryRun) {
    assertCanWriteTemplateInstalls(input.actor)
  }
  const template = await db.query.templateModel.findFirst({
    where: {
      id: input.templateId,
      workspaceId: input.workspaceId,
      deletedAt: { isNull: true as const },
    },
    columns: { id: true, tenantId: true },
  })
  if (!template) {
    throw notFoundException("Template not found")
  }
  const installations =
    await templateInstallationRepository.listActiveByPublisherRef({
      templateId: template.id,
      publisherRef: input.publisherRef,
    })
  if (installations.length === 0) {
    throw notFoundException("Template installation not found")
  }
  if (installations.some((row) => row.publisherUninstallGrant <= 0)) {
    throw notGrantedException()
  }
  // Same tenant, checked now and not only when it was installed.
  const workspace = await db.query.workspaceModel.findFirst({
    where: { id: installations[0].workspaceId },
    columns: { tenantId: true },
  })
  if (workspace?.tenantId !== template.tenantId) {
    throw notFoundException("Template installation not found")
  }

  // One transaction per installation: a failure part-way keeps what was done.
  // A retry lists only the still-active installations, so it finishes the rest.
  let counts = emptyCounts()
  let done = 0
  const failures: TemplateUninstallFailure[] = []
  let firstError: unknown
  for (const installation of installations) {
    try {
      counts = sumCounts(
        counts,
        await processInstallation({
          installationId: installation.id,
          workspaceId: installation.workspaceId,
          requestedBy: "publisher",
          requireGrant: true,
          dryRun: input.dryRun,
        }),
      )
      done++
    } catch (error) {
      firstError ??= error
      failures.push({
        installationId: installation.id,
        code: error instanceof ChatbotXException ? error.code : "unknown",
      })
    }
  }
  if (done === 0 && firstError !== undefined) {
    // Nothing progressed: surface the real error (grant revoked, frozen, ...).
    throw firstError
  }
  return { installations: installations.length, counts, done, failures }
}

export { describeUninstall } from "./uninstall-summary"
