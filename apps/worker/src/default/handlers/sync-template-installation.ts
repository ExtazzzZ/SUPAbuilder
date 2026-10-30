import { templateSyncRequestService } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { templateSyncExecuteService } from "@chatbotx.io/business/template-sync/execute"
import { type Job, UnrecoverableError } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { isFinalAttempt } from "../../lib/job-attempts"
import { logger } from "../../lib/logger"
import { enqueueInstalledAiFiles } from "./template-ai-files"

type SyncTemplateInstallationData = {
  syncId: string
  workspaceId: string
}

const UNKNOWN_SYNC_ERROR_CODE = "templateSyncFailed"

/** Failures a retry can never fix; anything else rolled back and is retried. */
const PERMANENT_SYNC_ERROR_CODES: ReadonlySet<string> = new Set([
  "templatePayloadIncompatible",
  "templateInstallationSourceMissing",
])

const errorCodeOf = (error: unknown): string =>
  error instanceof ChatbotXException ? error.code : UNKNOWN_SYNC_ERROR_CODE

/**
 * The sync row is the outbox: the handler claims it with a lease first, so a
 * redelivered or swept job for a finished or in-flight sync is a no-op. The
 * apply transaction rolls back entirely on any error.
 */
export async function syncTemplateInstallation(
  data: SyncTemplateInstallationData,
  job: Job,
) {
  const claim = await templateSyncExecuteService.claim(data)
  if (!claim) {
    return
  }
  const { claimToken, sync } = claim
  try {
    await templateSyncExecuteService.run({ sync, claimToken })
    await enqueueInstalledAiFiles(sync.installationId)
  } catch (error) {
    const errorCode = errorCodeOf(error)
    logger.error(
      { err: normalizeError(error), ...data, errorCode },
      "Template sync failed",
    )
    if (PERMANENT_SYNC_ERROR_CODES.has(errorCode)) {
      await templateSyncExecuteService.fail({
        syncId: sync.id,
        claimToken,
        errorCode,
      })
      throw new UnrecoverableError(
        error instanceof Error ? error.message : errorCode,
      )
    }
    if (isFinalAttempt(job)) {
      await templateSyncExecuteService.fail({
        syncId: sync.id,
        claimToken,
        errorCode,
      })
    } else {
      await templateSyncExecuteService.release({ syncId: sync.id, claimToken })
    }
    throw error
  }
}

/** Closes the row when the target owner is blocked, so the sweep never re-finds it. */
export async function skipBlockedTemplateSync(
  data: SyncTemplateInstallationData,
): Promise<void> {
  await templateSyncRequestService.closeUnclaimed({
    syncId: data.syncId,
    status: "skipped",
    errorCode: "workspaceOwnerBlocked",
  })
}
