import { templateInstallService, templateService } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { parseTemplateExport } from "@chatbotx.io/flow-config"
import { type Job, UnrecoverableError } from "bullmq"
import { normalizeError } from "universal-error-normalizer"
import { isFinalAttempt } from "../../lib/job-attempts"
import { logger } from "../../lib/logger"
import { enqueueInstalledAiFiles } from "./template-ai-files"

type InstallTemplateData = {
  installationId: string
  workspaceId: string
}

const UNKNOWN_INSTALL_ERROR_CODE = "templateInstallFailed"

/**
 * Failures a retry can never fix. Anything else is treated as transient: the
 * apply transaction already rolled back, so the claim is released and
 * BullMQ's retry (or the sweep) runs the install again.
 */
const PERMANENT_INSTALL_ERROR_CODES: ReadonlySet<string> = new Set([
  "templatePayloadIncompatible",
  "templateInstallationSourceMissing",
  "templateCrossTenantInstall",
  "templateCategoryPermissionDenied",
  "templateInvalidInboxBinding",
])

const errorCodeOf = (error: unknown): string =>
  error instanceof ChatbotXException ? error.code : UNKNOWN_INSTALL_ERROR_CODE

/**
 * Not under `handlers/imports/` — a share-link install has its own
 * `TemplateInstallation` status surface, never touching the `Import` table
 * (`Import.fileId` is `notNull()` with `onDelete: "restrict"`, and a
 * share-link install has no file).
 *
 * The row is the outbox: the handler claims it with a lease first, so a
 * redelivered or swept job for a finished or in-flight install is a no-op.
 */
export async function installTemplate(data: InstallTemplateData, job: Job) {
  const { installationId, workspaceId } = data

  const claim = await templateInstallService.claim({
    installationId,
    workspaceId,
  })
  if (!claim) {
    return
  }
  const { claimToken } = claim

  try {
    const { installation, payload, templateName, createInstallFolder } =
      await templateService.findInstallationByIdOrFail({
        installationId,
        workspaceId,
      })
    // Re-validate the stored payload on every install — never trust a
    // stored jsonb blob across a format change, even though it was already
    // validated once at save time.
    const parsed = parseTemplateExport(payload)
    if (!parsed.ok) {
      throw new ChatbotXException(
        `Template payload failed validation at install time: ${parsed.reason}`,
        "templatePayloadIncompatible",
      )
    }

    await templateInstallService.run({
      installationId,
      workspaceId,
      claimToken,
      permissions: installation.permissions,
      inboxBindings: installation.inboxBindings ?? undefined,
      payload: parsed.data,
      templateName,
      createInstallFolder,
      sourceVersion: installation.sourceVersion,
    })
    await enqueueInstalledAiFiles(installationId)
  } catch (error) {
    const errorCode = errorCodeOf(error)
    logger.error(
      { err: normalizeError(error), installationId, workspaceId, errorCode },
      "Template install failed",
    )

    if (PERMANENT_INSTALL_ERROR_CODES.has(errorCode)) {
      await templateInstallService.fail({
        installationId,
        claimToken,
        errorCode,
        error,
      })
      throw new UnrecoverableError(
        error instanceof Error ? error.message : errorCode,
      )
    }
    if (isFinalAttempt(job)) {
      await templateInstallService.fail({
        installationId,
        claimToken,
        errorCode,
        error,
      })
    } else {
      await templateInstallService.release({ installationId, claimToken })
    }
    throw error
  }
}

/** Closes the row when the target owner is blocked, so the sweep never re-finds it. */
export async function failBlockedTemplateInstall(
  data: InstallTemplateData,
): Promise<void> {
  await templateService.markInstallationFailed({
    installationId: data.installationId,
    errorCode: "workspaceOwnerBlocked",
    errorMessage: "The workspace owner is blocked",
  })
}
