import { type DatabaseClient, db, sql } from "@chatbotx.io/database/client"
import type {
  TemplateCategory,
  TemplatePermissions,
  TemplateResourceKind,
} from "@chatbotx.io/database/partials"
import { templateInstallationRepository } from "@chatbotx.io/database/repositories"
import { templateInstalledResourceModel } from "@chatbotx.io/database/schema"
import { setLocalStatementTimeout } from "@chatbotx.io/database/statement-timeout"
import { updateTriggerCache } from "@chatbotx.io/events"
import type { TemplateExport } from "@chatbotx.io/flow-config"
import { createId } from "@chatbotx.io/utils"
import { aiAgentService } from "../ai-agent/service"
import { automatedResponseService } from "../automated-response/service"
import { botFieldService } from "../bot-field/service"
import { couponService } from "../coupon/service"
import { customFieldService } from "../custom-field/service"
import { ChatbotXException, toPublicErrorMessage } from "../errors"
import { flowVersionService } from "../flow-version"
import { pipelineService } from "../pipeline/service"
import { resolveManifests } from "./adapters/manifests/resolve"
import { getTemplateAdapter, TEMPLATE_INSTALL_ORDER } from "./adapters/registry"
import type {
  PatchTask,
  StagedObjects,
  TemplateInstallContext,
  TemplateInstallWarning,
} from "./adapters/types"
import {
  rewriteBotFieldTokensDeep,
  rewriteCouponTokensDeep,
  rewriteFieldTokensDeep,
} from "./field-token-binder"
import { stampSyncedHashes } from "./sync-hash"
import { deleteCopiedObjects } from "./template-copied-objects"
import { entriesForCategory } from "./template-entries"
import { stageTemplateObjects } from "./template-staging"

const MAX_STORED_WARNINGS = 200

// The lease was committed before the apply transaction, and storage copies are
// staged before it opens (see `stageTemplateObjects`). The cap bounds a stuck
// statement.
const TEMPLATE_INSTALL_STATEMENT_TIMEOUT = "60s"
// Built when the install runs, not at import: this module sits behind the
// business barrel, which unrelated suites import with a partial client mock.
const idleTimeoutStatement = () =>
  sql.raw("SET LOCAL idle_in_transaction_session_timeout = '30s'")

export type TrackedResource = {
  category: TemplateCategory
  resourceKind: TemplateResourceKind
  resourceId: string
  sourceResourceId: string
  wasExisting: boolean
}

export { entriesForCategory } from "./template-entries"

/**
 * Builds the mutable `TemplateInstallContext` shared across all three
 * phases. `track`/`warn` are synchronous accumulators — no adapter awaits
 * them — so the actual `TemplateInstalledResource` batch insert happens
 * once, explicitly, after tracked rows accumulate (see `flushTracked`
 * below) rather than as an unawaited per-call side effect racing the
 * transaction commit.
 */
export type CreateInstallContextInput = {
  tx: DatabaseClient
  installationId: string
  workspaceId: string
  /** `{ sourceInboxId: targetInboxId }` the installer chose, if any. */
  inboxBindings?: Readonly<Record<string, string>>
  /** The workspace the template was published from. */
  sourceWorkspaceId: string
  /** Storage objects the staging pre-phase already copied. */
  staged?: StagedObjects
}

export const createInstallContext = (
  input: CreateInstallContextInput,
): {
  ctx: TemplateInstallContext
  tracked: TrackedResource[]
  warnings: TemplateInstallWarning[]
  resourceCount: { value: number }
} => {
  const tracked: TrackedResource[] = []
  const warnings: TemplateInstallWarning[] = []
  const resourceCount = { value: 0 }

  const ctx: TemplateInstallContext = {
    tx: input.tx,
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    idMaps: {},
    inboxBindings: input.inboxBindings,
    sourceWorkspaceId: input.sourceWorkspaceId,
    staged: input.staged,
    track: (entry) => {
      tracked.push(entry)
      resourceCount.value++
    },
    warn: (warning) => {
      if (warnings.length < MAX_STORED_WARNINGS) {
        warnings.push(warning)
      }
    },
  }

  return { ctx, tracked, warnings, resourceCount }
}

/** What a copy may do once installed; a reused row is never locked. */
type ItemLock = { allowEdit: boolean; allowDelete: boolean }

/**
 * The lock a tracked copy installs with, copied once and never re-derived: the
 * template's install-wide `allowEdit` / `allowDelete`, narrowed by the item's
 * own View-only choice in the payload's `permissions` map.
 */
export const lockFor = (
  entry: TrackedResource,
  input: Pick<TemplateInstallRunInput, "payload" | "permissions">,
): ItemLock => {
  if (entry.wasExisting) {
    return { allowEdit: true, allowDelete: true }
  }
  const itemLocked =
    input.payload.permissions?.[entry.category]?.[entry.sourceResourceId]
      ?.allowEdit === false
  return {
    allowEdit: input.permissions.allowEdit && !itemLocked,
    allowDelete: input.permissions.allowDelete,
  }
}

export const flushTracked = async (
  tx: DatabaseClient,
  installationId: string,
  workspaceId: string,
  tracked: TrackedResource[],
  lockOf: (entry: TrackedResource) => ItemLock,
): Promise<void> => {
  if (tracked.length === 0) {
    return
  }
  await tx.insert(templateInstalledResourceModel).values(
    tracked.map((entry) => ({
      id: createId(),
      installationId,
      workspaceId,
      category: entry.category,
      resourceKind: entry.resourceKind,
      resourceId: entry.resourceId,
      sourceResourceId: entry.sourceResourceId,
      wasExisting: entry.wasExisting,
      ...lockOf(entry),
    })),
  )
  tracked.length = 0
}

type RunInstallResult = {
  status: "completed" | "partial"
  warnings: TemplateInstallWarning[]
  resourceCount: number
  installFolderId: string | null
  /** Flows installed with a published version, for the after-publish effects. */
  publishedFlows: { flowId: string; versionId: string }[]
}

/**
 * Phase R (manifests) -> Phase 1 (adapters, in `TEMPLATE_INSTALL_ORDER`) ->
 * Phase 2 (drain every returned `PatchTask`) — all inside one transaction,
 * with provenance rows written inside it. A partial install has no
 * compensating-delete story across 15+ tables, so anything short of a full
 * commit means the whole install rolls back; per-resource failures (a
 * webchat's quota exhaustion, an unresolved reference) degrade to a
 * `warnings` entry instead of throwing.
 */
/** Whether this attempt's claim is still the installation's current one. */
const stillHoldsLease = async (
  input: Pick<
    TemplateInstallRunInput,
    "installationId" | "workspaceId" | "claimToken"
  >,
): Promise<boolean> => {
  const row = await templateInstallationRepository.findByIdAndWorkspace({
    id: input.installationId,
    workspaceId: input.workspaceId,
  })
  return row?.claimToken === input.claimToken && row.status === "installing"
}

const runInstall = async (
  tx: DatabaseClient,
  input: TemplateInstallRunInput,
  staged: StagedObjects,
): Promise<RunInstallResult> => {
  const lockOf = (entry: TrackedResource) => lockFor(entry, input)
  const { ctx, tracked, warnings, resourceCount } = createInstallContext({
    tx,
    installationId: input.installationId,
    workspaceId: input.workspaceId,
    inboxBindings: input.inboxBindings,
    sourceWorkspaceId: input.payload.source.workspaceId,
    staged,
  })
  const publishedFlows: RunInstallResult["publishedFlows"] = []
  ctx.publishedFlows = publishedFlows

  const { installFolderId } = await resolveManifests(
    ctx,
    input.payload.manifests,
    {
      skipMapped: false,
      mayUse: () => true,
      installFolder: input.createInstallFolder
        ? { templateName: input.templateName, mode: "create" }
        : undefined,
    },
  )
  await flushTracked(
    tx,
    input.installationId,
    input.workspaceId,
    tracked,
    lockOf,
  )

  // A field reused under another spelling, or created under a renamed name, is
  // addressed by `{{name}}` in the shipped text, so the tokens follow it.
  const resources = rewriteFieldTokensDeep(
    input.payload.resources,
    ctx.customFieldNameBindings ?? new Map(),
  )

  const patchTasks: PatchTask[] = []
  for (const category of TEMPLATE_INSTALL_ORDER) {
    const adapter = getTemplateAdapter(category)
    if (!adapter) {
      continue
    }
    // Coupon topics install before every category that can name one, so the
    // `{{coupon:<id>}}` tokens in this category's text can follow them.
    // Likewise `{{bot_field:<id>}}` follows the Account Field it resolved to
    // (settings installs before every category that can carry the text).
    const entries = rewriteBotFieldTokensDeep(
      rewriteCouponTokensDeep(
        entriesForCategory(resources, category),
        ctx.idMaps.couponTopic,
      ),
      ctx.idMaps.botField,
    )
    if (entries.length === 0) {
      continue
    }
    const tasks = await adapter.insert(ctx, entries)
    patchTasks.push(...tasks)
    await flushTracked(
      tx,
      input.installationId,
      input.workspaceId,
      tracked,
      lockOf,
    )
  }

  for (const task of patchTasks) {
    await task.apply(ctx)
  }
  await flushTracked(
    tx,
    input.installationId,
    input.workspaceId,
    tracked,
    lockOf,
  )

  return {
    status: warnings.length > 0 ? "partial" : "completed",
    warnings,
    resourceCount: resourceCount.value,
    installFolderId,
    publishedFlows,
  }
}

/**
 * Cache tags touched by an install, drained by the caller strictly after
 * the transaction commits — invalidating inside `tx` risks repopulating
 * Redis from an uncommitted read, exactly as `importFlowExport` documents.
 * Covers every category whose adapter can insert a resource with its own
 * cache layer: custom fields, keywords (automatedResponse), triggers, and AI
 * agents. An installed trigger or AI agent was previously served stale until
 * something else evicted it.
 */
export const invalidateAfterCommit = async (
  workspaceId: string,
): Promise<void> => {
  await Promise.all([
    customFieldService.invalidate({ workspaceId }),
    // Bot fields created by the settings adapter invalidate inside the tx
    // (botFieldService.create), which a concurrent reader can immediately
    // repopulate from a pre-commit snapshot — re-invalidate after commit so
    // the whole-workspace variable-map cache picks up the new fields.
    botFieldService.invalidate({ workspaceId }),
    automatedResponseService.invalidateCache(workspaceId),
    updateTriggerCache(workspaceId),
    aiAgentService.invalidate({ workspaceId }),
    pipelineService.invalidateList(workspaceId),
    couponService.invalidate(workspaceId),
  ])
}

/** A claim not renewed within this window is treated as a dead worker. */
export const TEMPLATE_INSTALL_LEASE_MS = 15 * 60 * 1000

/**
 * Raised inside the apply transaction when the lease was lost (another
 * worker reclaimed the row), so every write of this attempt rolls back.
 */
const TEMPLATE_INSTALL_LEASE_LOST_CODE = "templateInstallLeaseLost"

const templateInstallLeaseLostException = () =>
  new ChatbotXException(
    "The template install lease was lost",
    TEMPLATE_INSTALL_LEASE_LOST_CODE,
  )

const isLeaseLost = (error: unknown): boolean =>
  error instanceof ChatbotXException &&
  error.code === TEMPLATE_INSTALL_LEASE_LOST_CODE

/** A `pending` row younger than this may still be on its way to the queue. */
const TEMPLATE_INSTALL_UNCLAIMED_GRACE_MS = 5 * 60 * 1000
/** The sweep stops retrying an installation this old. */
const TEMPLATE_INSTALL_REDISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

const unfinishedWindow = (now: number) => ({
  pendingBefore: new Date(now - TEMPLATE_INSTALL_UNCLAIMED_GRACE_MS),
  leaseExpiredBefore: new Date(now - TEMPLATE_INSTALL_LEASE_MS),
})

export type TemplateInstallRunInput = {
  installationId: string
  workspaceId: string
  claimToken: string
  /** The installation's copied permissions (`allowEdit` / `allowDelete`). */
  permissions: TemplatePermissions
  /** `{ sourceInboxId: targetInboxId }` the installer chose, if any. */
  inboxBindings?: Readonly<Record<string, string>>
  payload: TemplateExport
  templateName: string
  createInstallFolder: boolean
  /** The template version being applied; recorded on the copies as their baseline. */
  sourceVersion: number
}

export const templateInstallService = {
  /**
   * Takes the install lease in one statement. `null` means the job is a
   * redelivery or another worker owns the row — the caller must do nothing.
   */
  async claim(input: {
    installationId: string
    workspaceId: string
  }): Promise<{ claimToken: string } | null> {
    const claimToken = createId()
    const claimed = await templateInstallationRepository.claim({
      id: input.installationId,
      workspaceId: input.workspaceId,
      claimToken,
      leaseExpiredBefore: new Date(Date.now() - TEMPLATE_INSTALL_LEASE_MS),
    })
    return claimed ? { claimToken } : null
  },

  /**
   * One bounded apply transaction: every write is fenced by the lease, and
   * it commits together with `completed`/`partial`. On any thrown error the
   * transaction rolls back entirely and the row is left `installing` — the
   * caller (the worker handler) classifies the error and either releases the
   * claim for a retry or records the terminal failure via `fail`.
   */
  async run(input: TemplateInstallRunInput): Promise<void> {
    const copiedObjectPaths: string[] = []
    let publishedFlows: RunInstallResult["publishedFlows"] = []
    try {
      // Storage I/O happens here, before the transaction: inside it the copies
      // would hold a connection idle past `idle_in_transaction_session_timeout`.
      const staged = await stageTemplateObjects({
        ctx: {
          workspaceId: input.workspaceId,
          // Only hashed into the object keys: salted with the claim, so an
          // attempt that lost its lease cannot delete the keys of the attempt
          // that took over (a lease check before a delete is not atomic).
          installationId: `${input.installationId}:${input.claimToken}`,
          sourceWorkspaceId: input.payload.source.workspaceId,
          trackCopiedObject: (path) => {
            copiedObjectPaths.push(path)
          },
        },
        resources: input.payload.resources,
      })
      await db.transaction(async (tx) => {
        await setLocalStatementTimeout(tx, TEMPLATE_INSTALL_STATEMENT_TIMEOUT)
        await tx.execute(idleTimeoutStatement())

        const outcome = await runInstall(tx, input, staged)
        publishedFlows = outcome.publishedFlows
        await stampSyncedHashes(tx, input.installationId, input.sourceVersion)

        const completed = await templateInstallationRepository.complete(
          {
            id: input.installationId,
            claimToken: input.claimToken,
            completion: {
              status: outcome.status,
              warnings: outcome.warnings,
              warningCount: outcome.warnings.length,
              resourceCount: outcome.resourceCount,
              installFolderId: outcome.installFolderId,
            },
          },
          tx,
        )
        if (!completed) {
          throw templateInstallLeaseLostException()
        }
      })
    } catch (error) {
      // After a lost lease the winner's rows may point at the very same
      // deterministic keys, so this attempt must not delete them. The lease can
      // also be lost without this attempt noticing (it only learns at
      // `complete`), so it is checked again rather than inferred from the error.
      if (!isLeaseLost(error) && (await stillHoldsLease(input))) {
        await deleteCopiedObjects(copiedObjectPaths)
      }
      throw error
    }

    await invalidateAfterCommit(input.workspaceId)
    // Same effects as a manual publish (version-list cache, Meta welcome-flow
    // sync, stale quick-reply state), which only make sense once the rows are
    // committed.
    await Promise.allSettled(
      publishedFlows.map(({ flowId, versionId }) =>
        flowVersionService.afterPublish({
          workspaceId: input.workspaceId,
          flowId,
          versionId,
        }),
      ),
    )
  },

  /**
   * Installations nobody finished — never enqueued / job lost, or a worker
   * that died holding the lease — and still young enough to retry.
   */
  listStale(limit: number) {
    const now = Date.now()
    return templateInstallationRepository.listStale({
      ...unfinishedWindow(now),
      createdAfter: new Date(now - TEMPLATE_INSTALL_REDISPATCH_MAX_AGE_MS),
      limit,
    })
  },

  /** Closes what the sweep has stopped retrying, so nothing stays pending forever. */
  abandonStale(): Promise<number> {
    const now = Date.now()
    return templateInstallationRepository.failAbandoned({
      ...unfinishedWindow(now),
      createdBefore: new Date(now - TEMPLATE_INSTALL_REDISPATCH_MAX_AGE_MS),
      errorCode: "templateInstallAbandoned",
      errorMessage: "The template install could not be completed",
    })
  },

  /** Gives the claim back so BullMQ's retry (or the sweep) can run the install again. */
  async release(input: {
    installationId: string
    claimToken: string
  }): Promise<void> {
    await templateInstallationRepository.release({
      id: input.installationId,
      claimToken: input.claimToken,
    })
  },

  /** Records the terminal failure, fenced by the lease, in its own transaction. */
  async fail(input: {
    installationId: string
    claimToken: string
    errorCode: string
    error: unknown
  }): Promise<void> {
    await templateInstallationRepository.fail({
      id: input.installationId,
      claimToken: input.claimToken,
      errorCode: input.errorCode,
      errorMessage: toPublicErrorMessage(
        input.error,
        "Template install failed",
      ),
    })
  },
}
