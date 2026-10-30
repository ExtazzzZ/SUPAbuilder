import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type { TemplateResourceCategory } from "@chatbotx.io/database/partials"
import {
  type TemplateSyncRow,
  templateInstallationRepository,
  templateInstallationSyncRepository,
  templateResourceBackupRepository,
  templateVersionRepository,
} from "@chatbotx.io/database/repositories"
import { setLocalStatementTimeout } from "@chatbotx.io/database/statement-timeout"
import { parseTemplateExport } from "@chatbotx.io/flow-config"
import { createId } from "@chatbotx.io/utils"
import { ChatbotXException, notFoundException } from "../errors"
import { flowVersionService } from "../flow-version"
import { getTemplateAdapter } from "./adapters/registry"
import { isUpdatable } from "./adapters/shared"
import type { StagedObjects } from "./adapters/types"
import { invalidateAfterCommit } from "./install.service"
import { assertResourceEditable } from "./installed-resource.service"
import { TEMPLATE_LOCKED_CONTENT_KEYS } from "./lock-policy"
import {
  assertCanUseTemplateCategories,
  assertCanWriteTemplateInstalls,
  type TemplateActor,
} from "./permissions"
import { templateService } from "./service"
import {
  applyVersion,
  type PublishedFlows,
  stageSyncObjects,
  syncAttemptKey,
} from "./sync-apply"
import { deleteCopiedObjects } from "./template-copied-objects"
import { templateSourceMissingException } from "./template-errors"
import { SYNC_LEASE_MS } from "./template-leases"
import {
  acquireTemplateResourceLocks,
  withTemplateLockedTransaction,
} from "./template-resource-locks"

export { TRACKED_KIND_BY_CATEGORY } from "./sync-apply"

const TEMPLATE_SYNC_STATEMENT_TIMEOUT = "60s"

const LEASE_LOST_CODE = "templateSyncLeaseLost"

const leaseLostException = () =>
  new ChatbotXException("The template sync lease was lost", LEASE_LOST_CODE)

const isLeaseLost = (error: unknown): boolean =>
  error instanceof ChatbotXException && error.code === LEASE_LOST_CODE

export const templateSyncExecuteService = {
  /**
   * Puts back what a sync overwrote on one copy. The server resolves and
   * checks every link (backup, installation, copy, workspace) and takes the
   * same install lock as a sync, so it can not interleave with one. The
   * restored copy then counts as locally modified for the next sync.
   */
  async restoreBackup(input: {
    workspaceId: string
    installationId: string
    backupId: string
    actor: TemplateActor
  }): Promise<void> {
    assertCanWriteTemplateInstalls(input.actor)
    const installation =
      await templateInstallationRepository.findByIdAndWorkspace({
        id: input.installationId,
        workspaceId: input.workspaceId,
      })
    if (
      !(
        installation?.sourceTemplateId &&
        ["completed", "partial"].includes(installation.status)
      )
    ) {
      throw notFoundException("Template installation not found")
    }
    const backup =
      await templateResourceBackupRepository.findByIdAndInstallation({
        id: input.backupId,
        installationId: installation.id,
        workspaceId: input.workspaceId,
      })
    if (!backup) {
      throw notFoundException("Backup not found")
    }
    const sourceTemplateId = installation.sourceTemplateId
    await withTemplateLockedTransaction(
      async (tx) => {
        if (
          await templateInstallationSyncRepository.findActiveByInstallation(
            installation.id,
            tx,
          )
        ) {
          throw new ChatbotXException(
            "A sync of this installation is in progress",
            "templateSyncInProgress",
            409,
          )
        }
        const row = (
          await templateInstallationSyncRepository.listInstalledResources(
            installation.id,
            tx,
          )
        ).find((candidate) => candidate.id === backup.installedResourceId)
        if (!row || row.detachedAt || row.wasExisting) {
          throw notFoundException("Backup target not found")
        }
        assertCanUseTemplateCategories(input.actor, { [row.category]: 1 })
        // Another installation that still locks this copy wins (P2 precedence);
        // this also takes the copy's `tpl-res:` lock, before anything is read.
        await assertResourceEditable({
          workspaceId: input.workspaceId,
          resourceKind: row.resourceKind,
          resourceIds: [row.resourceId],
          changedKeys: TEMPLATE_LOCKED_CONTENT_KEYS[row.resourceKind],
          excludeInstallationIds: [installation.id],
          tx,
        })
        const handler = getTemplateAdapter(
          row.category as TemplateResourceCategory,
        )?.sync
        if (
          !(handler && isUpdatable(handler)) ||
          row.resourceKind !== backup.resourceKind
        ) {
          throw new ChatbotXException(
            "This backup can not be restored",
            "templateBackupNotRestorable",
            409,
          )
        }
        if ((await handler.project(tx, row.resourceId)) === null) {
          throw notFoundException("Backup target not found")
        }
        await handler.restoreBackup(
          tx,
          row.resourceId,
          backup.content,
          backup.formatVersion,
        )
      },
      {
        prepare: async (tx) => {
          await setLocalStatementTimeout(tx, TEMPLATE_SYNC_STATEMENT_TIMEOUT)
          await templateInstallationRepository.lockInstallRequest(
            { workspaceId: input.workspaceId, sourceTemplateId },
            tx,
          )
        },
      },
    )
    await invalidateAfterCommit(input.workspaceId)
  },

  /** Takes the sync lease; `null` means a redelivery or another worker owns it. */
  async claim(input: { syncId: string; workspaceId: string }) {
    const claimToken = createId()
    const claimed = await templateInstallationSyncRepository.claim({
      id: input.syncId,
      workspaceId: input.workspaceId,
      claimToken,
      leaseExpiredBefore: new Date(Date.now() - SYNC_LEASE_MS),
    })
    return claimed ? { claimToken, sync: claimed } : null
  },

  async release(input: { syncId: string; claimToken: string }) {
    await templateInstallationSyncRepository.release({
      id: input.syncId,
      claimToken: input.claimToken,
    })
  },

  async fail(input: { syncId: string; claimToken: string; errorCode: string }) {
    await templateInstallationSyncRepository.finish({
      id: input.syncId,
      claimToken: input.claimToken,
      outcome: { status: "failed", errorCode: input.errorCode },
    })
  },

  /**
   * One sync, in one bounded transaction fenced by the lease: it applies the
   * newest template version to the installed copies (see the rules in the
   * plan, P7) and commits together with the sync's outcome. Throws on any
   * error, rolling everything back; the caller classifies it.
   */
  async run(input: {
    sync: TemplateSyncRow
    claimToken: string
  }): Promise<void> {
    const { sync, claimToken } = input
    // Only to find the template to lock on; everything that decides the sync
    // is read again under the lock below.
    const probe = await templateInstallationRepository.findByIdAndWorkspace({
      id: sync.installationId,
      workspaceId: sync.workspaceId,
    })
    if (!probe?.templateId) {
      await finishSkipped(sync, claimToken, "templateInstallationInactive")
      return
    }
    const templateId = probe.templateId

    // Objects the adapters copy into storage during the transaction; deleted
    // again if it rolls back, since nothing will reference them.
    const copiedObjectPaths: string[] = []
    let published: PublishedFlows
    try {
      const applied = await applyLatestVersion({
        sync,
        claimToken,
        probe,
        templateId,
        copiedObjectPaths,
      })
      published = applied.published
      if (applied.skipped) {
        // The transaction committed only the skip: nothing references what was staged.
        await deleteCopiedObjects(copiedObjectPaths.splice(0))
      }
    } catch (error) {
      // After a lost lease the winner's rows may point at the very same
      // deterministic keys, so this attempt must not delete them. The lease
      // can also be lost without this attempt noticing, so it is checked again
      // rather than inferred from the error.
      if (!isLeaseLost(error) && (await stillHoldsLease(sync, claimToken))) {
        await deleteCopiedObjects(copiedObjectPaths)
      }
      throw error
    }
    await invalidateAfterCommit(probe.workspaceId)
    await Promise.all(
      published.map(({ flowId, versionId }) =>
        flowVersionService.afterPublish({
          workspaceId: probe.workspaceId,
          flowId,
          versionId,
        }),
      ),
    )
  },
}

/** The person (or token) a sync acts as, with the kind that survives a user delete. */
const actingIdentity = (
  sync: TemplateSyncRow,
  installation: SyncInstallation,
) =>
  sync.trigger === "autoUpdate"
    ? {
        installedBy: installation.installedBy,
        installedByKind: installation.installedByKind,
      }
    : { installedBy: sync.requestedBy, installedByKind: sync.requestedByKind }

/** Whether this attempt's claim is still the sync's current one. */
const stillHoldsLease = async (
  sync: TemplateSyncRow,
  claimToken: string,
): Promise<boolean> => {
  const row = await templateInstallationSyncRepository.findById({
    id: sync.id,
    workspaceId: sync.workspaceId,
  })
  return row?.claimToken === claimToken && row.status === "running"
}

type SyncInstallation = NonNullable<
  Awaited<
    ReturnType<typeof templateInstallationRepository.findByIdAndWorkspace>
  >
>

/**
 * The staging pre-phase, from an UNLOCKED read of what the transaction will
 * decide again under the lock: storage I/O must not hold a connection idle
 * inside it. Returns `undefined` when the sync looks like it will be skipped
 * (nothing is copied then); `applyVersion` falls back to staging inline, which
 * only happens if the unlocked read was stale.
 */
const stageBeforeTransaction = async (input: {
  sync: TemplateSyncRow
  claimToken: string
  installation: SyncInstallation
  templateId: string
  copiedObjectPaths: string[]
}): Promise<StagedPayload | undefined> => {
  const { sync, installation, templateId } = input
  if (
    installation.sourceDeletedAt ||
    !["completed", "partial"].includes(installation.status) ||
    (sync.trigger === "autoUpdate" && !installation.autoUpdate)
  ) {
    return
  }
  const latest = await templateVersionRepository.findLatest(templateId)
  if (
    !latest ||
    (sync.trigger === "autoUpdate" &&
      installation.sourceVersion >= latest.version)
  ) {
    return
  }
  const parsed = parseTemplateExport(latest.payload)
  if (!parsed.ok) {
    return
  }
  const installerActor = await templateService.resolveInstallerActor({
    ...actingIdentity(sync, installation),
    workspaceId: installation.workspaceId,
  })
  if (!installerActor) {
    return
  }
  const objects = await stageSyncObjects({
    installation,
    attemptKey: syncAttemptKey(sync.id, input.claimToken),
    payload: parsed.data,
    installerActor,
    copiedObjectPaths: input.copiedObjectPaths,
  })
  return { objects, version: latest.version, hash: latest.payloadHash }
}

/** What the unlocked staging pre-phase staged, and the version it read. */
type StagedPayload = {
  objects: StagedObjects
  version: number
  hash: string
}

const MAX_STAGE_ATTEMPTS = 3

const RESTAGE_CODE = "templateSyncRestage"

const isRestage = (error: unknown): boolean =>
  error instanceof ChatbotXException && error.code === RESTAGE_CODE

type ApplyResult = { published: PublishedFlows; skipped: boolean }

/**
 * Stages outside the transaction, then applies inside it. The version is read
 * again under the lock; if the template moved on in between, the staged map
 * belongs to another version, so the attempt rolls back and stages again
 * (bounded; the last attempt stages inline under the lock instead).
 */
const applyLatestVersion = async (input: {
  sync: TemplateSyncRow
  claimToken: string
  probe: SyncInstallation
  templateId: string
  copiedObjectPaths: string[]
}): Promise<ApplyResult> => {
  const { sync, claimToken, probe, templateId, copiedObjectPaths } = input
  for (let attempt = 1; ; attempt++) {
    const staged = await stageBeforeTransaction({
      sync,
      claimToken,
      installation: probe,
      templateId,
      copiedObjectPaths,
    })
    try {
      return await applyInTransaction({
        ...input,
        staged,
        mayRestage: attempt < MAX_STAGE_ATTEMPTS,
      })
    } catch (error) {
      if (!isRestage(error)) {
        throw error
      }
      // The keys are per sync, so only a redelivery of this very sync could
      // share them: delete only while this attempt still owns the lease.
      if (await stillHoldsLease(sync, claimToken)) {
        await deleteCopiedObjects(copiedObjectPaths.splice(0))
      }
    }
  }
}

const applyInTransaction = async (input: {
  sync: TemplateSyncRow
  claimToken: string
  probe: SyncInstallation
  templateId: string
  copiedObjectPaths: string[]
  staged: StagedPayload | undefined
  mayRestage: boolean
}): Promise<ApplyResult> => {
  const { sync, claimToken, probe, templateId, copiedObjectPaths } = input
  return await db.transaction(async (tx) => {
    await setLocalStatementTimeout(tx, TEMPLATE_SYNC_STATEMENT_TIMEOUT)
    // Excludes a concurrent install request, sync or restore of the pair.
    await templateInstallationRepository.lockInstallRequest(
      { workspaceId: probe.workspaceId, sourceTemplateId: templateId },
      tx,
    )
    const skip = async (code: string): Promise<ApplyResult> => {
      // A stale worker whose lease moved on must not report a skip: its caller
      // would delete staged objects the winning attempt's rows may reference.
      if (!(await finishSkipped(sync, claimToken, code, tx))) {
        throw leaseLostException()
      }
      return { published: NO_PUBLISHED_FLOWS, skipped: true }
    }

    const installation =
      await templateInstallationRepository.findByIdAndWorkspace(
        { id: sync.installationId, workspaceId: sync.workspaceId },
        tx,
      )
    if (
      !installation ||
      installation.sourceDeletedAt ||
      !["completed", "partial"].includes(installation.status)
    ) {
      return await skip("templateInstallationInactive")
    }
    // Every copy this sync may overwrite, locked in one sorted pass before
    // anything is read or fingerprinted: a local edit racing the sync waits,
    // then diffs against the post-sync state. The install-request lock above
    // always precedes these, and sync writes go through adapters and
    // repositories (never the guarded services), so no bypass argument is
    // needed. New resources have no row yet and need no lock.
    await acquireTemplateResourceLocks(
      tx,
      (
        await templateInstallationSyncRepository.listInstalledResources(
          installation.id,
          tx,
        )
      )
        .filter((row) => !(row.wasExisting || row.detachedAt))
        .map((row) => ({ kind: row.resourceKind, resourceId: row.resourceId })),
    )
    const latest = await templateVersionRepository.findLatest(templateId, tx)
    if (!latest) {
      throw templateSourceMissingException()
    }
    if (sync.trigger === "autoUpdate") {
      // A queued or swept auto-update must respect what the installer chose since.
      if (!installation.autoUpdate) {
        return await skip("templateAutoUpdateOff")
      }
      if (installation.sourceVersion >= latest.version) {
        return await skip("templateUpToDate")
      }
    }
    // Never apply a payload with another version's staged objects.
    const stagedMatches =
      input.staged?.version === latest.version &&
      input.staged.hash === latest.payloadHash
    if (input.staged && !stagedMatches && input.mayRestage) {
      throw new ChatbotXException(
        "The template changed while its objects were staged",
        RESTAGE_CODE,
      )
    }
    const parsed = parseTemplateExport(latest.payload)
    if (!parsed.ok) {
      throw new ChatbotXException(
        `Template payload failed validation at sync time: ${parsed.reason}`,
        "templatePayloadIncompatible",
      )
    }
    // A sync may only write what the person behind it could have installed:
    // the member who asked, or the installer for an automatic update. A
    // token request (no member) runs with token power. The template may have
    // gained a category since the request was authorized, so this is checked
    // again against the version actually applied.
    const installerActor = await templateService.resolveInstallerActor({
      ...actingIdentity(sync, installation),
      workspaceId: installation.workspaceId,
    })
    if (!installerActor) {
      return await skip("templateInstallerAccessLost")
    }

    if (input.staged && !stagedMatches) {
      // Final fallback: the staged map belongs to another version. Its copies
      // are unreferenced once the inline staging below re-copies what this
      // version needs, so remove them first rather than leak them.
      await deleteDiscardedStagedObjects(
        input.staged.objects,
        copiedObjectPaths,
        () => stillHoldsLease(sync, claimToken),
      )
    }
    const applied = await applyVersion(tx, {
      sync,
      claimToken,
      installation,
      payload: parsed.data,
      version: latest.version,
      appliedHash: latest.payloadHash,
      fromVersion: installation.sourceVersion,
      installerActor,
      copiedObjectPaths,
      // After the last restage a mismatch falls back to inline staging.
      staged: stagedMatches ? input.staged?.objects : undefined,
    })
    const finished = await templateInstallationSyncRepository.finish(
      { id: sync.id, claimToken, outcome: applied.outcome },
      tx,
    )
    if (!finished) {
      throw leaseLostException()
    }
    await templateInstallationSyncRepository.completeInstallationSync(
      { installationId: installation.id, version: latest.version },
      tx,
    )
    if (sync.trigger === "reinstall") {
      // Chatrace parity: a reinstall is an install; auto/manual syncs are not.
      await templateInstallationRepository.recordInstallEvent(
        installation.id,
        tx,
      )
    }
    return { published: applied.publishedFlows, skipped: false }
  })
}

const NO_PUBLISHED_FLOWS: PublishedFlows = []

/** Deletes the staged copies of a discarded map (and forgets them for the failure cleanup). */
const deleteDiscardedStagedObjects = async (
  staged: StagedObjects,
  copiedObjectPaths: string[],
  holdsLease: () => Promise<boolean>,
): Promise<void> => {
  const discarded = new Set(
    [...staged.values()].flatMap((object) =>
      "targetPath" in object ? [object.targetPath] : [],
    ),
  )
  if (discarded.size === 0 || !(await holdsLease())) {
    return
  }
  await deleteCopiedObjects([...discarded])
  copiedObjectPaths.splice(
    0,
    copiedObjectPaths.length,
    ...copiedObjectPaths.filter((path) => !discarded.has(path)),
  )
}

const finishSkipped = async (
  sync: TemplateSyncRow,
  claimToken: string,
  errorCode: string,
  tx?: DatabaseClient,
): Promise<boolean> =>
  await templateInstallationSyncRepository.finish(
    { id: sync.id, claimToken, outcome: { status: "skipped", errorCode } },
    tx,
  )
