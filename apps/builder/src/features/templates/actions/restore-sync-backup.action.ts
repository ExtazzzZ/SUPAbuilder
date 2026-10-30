"use server"

import { canViewTemplateInstalls } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { templateSyncExecuteService } from "@chatbotx.io/business/template-sync/execute"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceActionClient } from "@/lib/safe-action"

/** Puts back what a sync overwrote on an edited copy (flows restore into the draft only). */
export const restoreSyncBackupAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(z.object({ backupId: zodBigintAsString() }))
  .action(
    async ({
      ctx: { workspaceMemberPermissions },
      bindArgsParsedInputs: [workspaceId, installationId],
      parsedInput: { backupId },
    }) => {
      if (!canViewTemplateInstalls(workspaceMemberPermissions)) {
        throw new ChatbotXException(
          "You don't have permission to restore template installs",
          "templateCategoryPermissionDenied",
          403,
        )
      }
      await templateSyncExecuteService.restoreBackup({
        workspaceId,
        installationId,
        backupId,
        actor: { kind: "member", permissions: workspaceMemberPermissions },
      })
      return { backupId }
    },
  )
