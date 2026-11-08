import "server-only"

import { checkCrmAccess, getSupaLoginConfig } from "@chatbotx.io/auth/supalogin"
import { supacrmSourceBindingService } from "@chatbotx.io/business/supacrm-source-binding"
import { and, db, eq } from "@chatbotx.io/database/client"
import { accountModel, ROOT_TENANT_ID } from "@chatbotx.io/database/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"
import { authorizeNativeSource, type NativeSourceTarget } from "./authorization"

/** Local BetterAuth id/email не заменяют проверенный issuer/sub SUPAlogin. */
async function nativeIdentity(workspaceId: string) {
  const config = getSupaLoginConfig()
  if (!config || config.workspaceId !== workspaceId) {
    return null
  }
  await requireWorkspacePermission(workspaceId, "flows")
  const current = await getCurrentUserAndTargetWorkspace(workspaceId)
  if (
    !current ||
    current.isSupportSession ||
    !hasWorkspacePermission(current.targetWorkspaceMember.permissions, "flows")
  ) {
    return null
  }
  const accounts = await db
    .select({ accountId: accountModel.accountId })
    .from(accountModel)
    .where(
      and(
        eq(accountModel.userId, current.user.id),
        eq(accountModel.providerId, "supalogin"),
        eq(accountModel.tenantId, ROOT_TENANT_ID),
      ),
    )
    .limit(2)
  const prefix = `${config.issuer}|`
  if (accounts.length !== 1 || !accounts[0]?.accountId.startsWith(prefix)) {
    return null
  }
  const subject = accounts[0].accountId.slice(prefix.length)
  if (!subject) {
    return null
  }
  const access = await checkCrmAccess(config, {
    userId: subject,
    email: current.user.email,
  })
  if (
    !access.allowed ||
    (current.targetWorkspaceMember.role === "owner" && access.role !== "admin")
  ) {
    return null
  }
  return { workspaceId, subject, flows: true }
}

export function authorizeNativeSourceRequest(target: NativeSourceTarget) {
  return authorizeNativeSource(target, {
    identity: nativeIdentity,
    binding: (scope) => supacrmSourceBindingService.getDocumentBinding(scope),
  })
}

/** Descriptor для native FlowPage; ошибки чтения не включают legacy controller. */
export async function resolveNativeSourceDocument(target: NativeSourceTarget) {
  try {
    await requireWorkspacePermission(target.workspaceId, "flows")
    const binding = await supacrmSourceBindingService.getDocumentBinding(target)
    if (binding.kind !== "source") {
      return binding
    }
    return (
      (await authorizeNativeSourceRequest(target))?.binding ?? {
        kind: "blocked" as const,
        code: "source_binding_unavailable" as const,
      }
    )
  } catch {
    return {
      kind: "blocked" as const,
      code: "source_binding_unavailable" as const,
    }
  }
}
