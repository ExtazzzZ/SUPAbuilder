"use server"

import {
  canViewTemplateInstalls,
  templateSyncRequestService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceActionClient } from "@/lib/safe-action"

/** The installer's switch for what the publisher may see and do; like retry and sync it needs only the right to see installs. */
export const setPublisherUninstallGrantAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(z.object({ granted: z.boolean() }))
  .action(
    async ({
      ctx: { workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
      parsedInput,
    }) => {
      if (!canViewTemplateInstalls(workspaceMemberPermissions)) {
        throw new ChatbotXException(
          "You don't have permission to change template installs",
          "templateCategoryPermissionDenied",
          403,
        )
      }
      await templateSyncRequestService.setPublisherUninstallGrant({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
        granted: parsedInput.granted,
      })
      return { granted: parsedInput.granted }
    },
  )
