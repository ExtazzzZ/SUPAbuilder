"use server"

import {
  canViewTemplateInstalls,
  templateSyncRequestService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { workspaceActionClient } from "@/lib/safe-action"
import { enqueueSync } from "../lib/request-install"

/**
 * Brings an installed copy up to the template's newest version. Like retry,
 * it needs only the permission to see installs; the service re-checks the
 * installer's permission for every category the template contains.
 */
export const syncInstallationAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .action(
    async ({
      ctx: { user, workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
    }) => {
      if (!canViewTemplateInstalls(workspaceMemberPermissions)) {
        throw new ChatbotXException(
          "You don't have permission to update template installs",
          "templateCategoryPermissionDenied",
          403,
        )
      }
      const requested = await templateSyncRequestService.request({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
        trigger: "manual",
        requestedBy: user.id,
      })
      await enqueueSync(requested.syncId, requested.workspaceId)
      return { syncId: requested.syncId }
    },
  )
