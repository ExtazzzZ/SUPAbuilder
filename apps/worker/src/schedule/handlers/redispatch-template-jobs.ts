import {
  templateAiFileDispatchService,
  templateInstallService,
  templateSyncRequestService,
} from "@chatbotx.io/business"
import { getChildLogger } from "@chatbotx.io/logger"
import { mapWithConcurrency } from "@chatbotx.io/utils"
import {
  enqueueFanOutTemplateUpdate,
  enqueueInstallTemplate,
  enqueueProcessAIFile,
  enqueueSyncTemplateInstallation,
} from "@chatbotx.io/worker-config"

const log = getChildLogger("redispatch-template-jobs")

const BATCH_SIZE = 500
const ENQUEUE_CONCURRENCY = 10

/**
 * The template-install outbox sweep: re-enqueues installations nobody
 * finished (the enqueue failed, the job was lost, or the worker died holding
 * the lease). The job id is deterministic and the handler claims atomically,
 * so re-enqueueing an installation that is in fact still running is
 * harmless. Installations too old to retry are closed as failed so none
 * stays pending forever.
 */
export async function redispatchTemplateJobs(): Promise<void> {
  // Its own failure must not keep stuck installations from being re-dispatched.
  try {
    await redispatchTemplateAiFiles()
  } catch (error) {
    log.error({ err: error }, "Template AI file sweep failed")
  }

  // Likewise isolated: syncs and the auto-update catch-up are independent of installs.
  try {
    await redispatchTemplateSyncs()
  } catch (error) {
    log.error({ err: error }, "Template sync sweep failed")
  }

  const abandoned = await templateInstallService.abandonStale()
  if (abandoned > 0) {
    log.warn({ abandoned }, "Closed template installations as abandoned")
  }

  const stale = await templateInstallService.listStale(BATCH_SIZE)
  const results = await mapWithConcurrency(
    stale,
    ENQUEUE_CONCURRENCY,
    ({ id, workspaceId }) =>
      enqueueInstallTemplate({ installationId: id, workspaceId }),
  )
  const failed = results.filter(({ status }) => status === "rejected").length
  if (failed > 0) {
    log.error({ failed }, "Could not re-enqueue some template installations")
  }
  if (stale.length > 0) {
    log.info({ requeued: stale.length - failed }, "Re-dispatched installations")
  }
}

/**
 * Knowledge files an install created are queued for embedding only after the
 * install committed; this re-enqueues the ones whose job was lost and closes
 * the ones that have waited too long. Regular AI files are never listed.
 */
export async function redispatchTemplateAiFiles(): Promise<void> {
  const { redispatch, expired } =
    await templateAiFileDispatchService.listForSweep()
  if (expired > 0) {
    log.warn({ expired }, "Closed queued template AI files as failed")
  }
  const results = await mapWithConcurrency(
    redispatch,
    ENQUEUE_CONCURRENCY,
    ({ aiFileId, runId }) => enqueueProcessAIFile({ aiFileId, runId }),
  )
  const failed = results.filter(({ status }) => status === "rejected").length
  if (failed > 0) {
    log.error({ failed }, "Could not re-enqueue some template AI files")
  }
  if (redispatch.length > 0) {
    log.info(
      { requeued: redispatch.length - failed },
      "Re-dispatched template AI files",
    )
  }
}

/**
 * The template-sync outbox sweep: re-enqueues syncs nobody finished, and
 * re-runs the fan-out of any template with following installations still
 * behind (the save's fan-out job may have been lost). Both are idempotent:
 * job ids are deterministic, sync rows insert-or-ignore, and the handler
 * claims atomically.
 */
export async function redispatchTemplateSyncs(): Promise<void> {
  const abandoned = await templateSyncRequestService.abandonStale()
  if (abandoned > 0) {
    log.warn({ abandoned }, "Closed template syncs as abandoned")
  }
  const unfinished = await templateSyncRequestService.listUnfinished(BATCH_SIZE)
  const results = await mapWithConcurrency(
    unfinished,
    ENQUEUE_CONCURRENCY,
    ({ id, workspaceId }) =>
      enqueueSyncTemplateInstallation({ syncId: id, workspaceId }),
  )
  const failed = results.filter(({ status }) => status === "rejected").length
  if (failed > 0) {
    log.error({ failed }, "Could not re-enqueue some template syncs")
  }

  const behind =
    await templateSyncRequestService.listTemplatesNeedingFanOut(BATCH_SIZE)
  await mapWithConcurrency(behind, ENQUEUE_CONCURRENCY, (template) =>
    enqueueFanOutTemplateUpdate(template),
  )
}
