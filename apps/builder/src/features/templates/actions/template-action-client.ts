import {
  assertCanManageTemplates,
  type TemplateActor,
} from "@chatbotx.io/business"
import { workspaceActionClient } from "@/lib/safe-action"

/**
 * Shared gate for every template mutation action — applies the business-layer
 * manage rule once and hands the derived `templateActor` to the handler, so a
 * new action can't forget either. `workspaceActionClient` alone only verifies
 * membership; page-level guards are bypassable by calling an action directly
 * (see `update-webchat.action.ts`'s comment for the same precedent), so the
 * check has to live in the action layer too. Category checks that depend on
 * the template's contents run in `templateService`.
 */
export const templateActionClient = workspaceActionClient.use(
  ({ ctx, next }) => {
    const templateActor: TemplateActor = {
      kind: "member",
      permissions: ctx.workspaceMemberPermissions,
    }
    assertCanManageTemplates(templateActor)
    return next({ ctx: { templateActor } })
  },
)
