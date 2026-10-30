"use server"

import {
  canViewTemplateInstalls,
  templateSyncRequestService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceActionClient } from "@/lib/safe-action"

export const setInstallationAutoUpdateAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(z.object({ autoUpdate: z.boolean() }))
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
      await templateSyncRequestService.setAutoUpdate({
        workspaceId,
        installationId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
        autoUpdate: parsedInput.autoUpdate,
      })
      return { autoUpdate: parsedInput.autoUpdate }
    },
  )
