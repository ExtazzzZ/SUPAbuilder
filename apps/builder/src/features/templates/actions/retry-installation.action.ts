"use server"

import {
  canViewTemplateInstalls,
  templateInstallationRequestService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { enqueueInstall } from "../lib/request-install"

/**
 * Queues a failed install again. Like the installs page, it needs only the
 * permission to see installs: an installer without `flows` (an `ecommerce`
 * member installing a products template) must be able to retry their own
 * install. The service re-authorizes the retrier against the template's
 * current contents and makes them the installing user the worker checks.
 */
export const retryInstallationAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      ctx: { user, workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
    }) => {
      if (!canViewTemplateInstalls(workspaceMemberPermissions)) {
        throw new ChatbotXException(
          "You don't have permission to retry template installs",
          "templateCategoryPermissionDenied",
          403,
        )
      }
      const installation = await templateInstallationRequestService.retry({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
        retriedBy: user.id,
      })
      await enqueueInstall(installation.id, installation.workspaceId)
      return { installationId: installation.id }
    },
  )
