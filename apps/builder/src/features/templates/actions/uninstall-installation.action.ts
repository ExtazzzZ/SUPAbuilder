"use server"

import { canViewTemplateInstalls } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { templateUninstallService } from "@chatbotx.io/business/template-uninstall"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"

/**
 * The installer's own uninstall, like retry and sync, needs only the right to
 * see installs; the service checks the permission of everything the install
 * holds.
 */
const installerActionClient = workspaceActionClient.use(({ ctx, next }) => {
  if (!canViewTemplateInstalls(ctx.workspaceMemberPermissions)) {
    throw new ChatbotXException(
      "You don't have permission to uninstall templates",
      "templateCategoryPermissionDenied",
      403,
    )
  }
  return next()
})

export const previewUninstallInstallationAction = installerActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      ctx: { workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
    }) =>
      await templateUninstallService.previewAsInstaller({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
      }),
  )

export const uninstallInstallationAction = installerActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      ctx: { workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
    }) =>
      await templateUninstallService.uninstallAsInstaller({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
      }),
  )
