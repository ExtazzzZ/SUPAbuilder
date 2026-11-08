import { workspaceMemberService } from "@chatbotx.io/business"
import { and, db, eq, sql } from "@chatbotx.io/database/client"
import {
  accountModel,
  ROOT_TENANT_ID,
  sessionModel,
  userModel,
  workspaceMemberModel,
  workspaceModel,
} from "@chatbotx.io/database/schema"
import {
  checkCrmAccess,
  type SupaLoginConfig,
  type SupaLoginIdentity,
} from "./supalogin-config"

const PROVIDER = "supalogin"
const permissions = {
  superAdmin: false,
  analytics: true,
  flows: true,
  contacts: true,
  onlyAssignedContacts: false,
  emailAndPhone: true,
  broadcast: false,
  ecommerce: false,
}

/** Сопоставление только по проверенному issuer/sub; совпадения email недостаточно. */
export async function provisionSupaLoginUser(
  config: SupaLoginConfig,
  identity: SupaLoginIdentity,
) {
  const access = await checkCrmAccess(config, identity)
  if (!access.allowed) {
    throw new Error("CRM access denied")
  }
  return db.transaction(async (tx) => {
    // Сериализует создание identity и membership без новых таблиц/миграций.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`supabuilder:${config.workspaceId}`}, 0))`,
    )
    const [workspace] = await tx
      .select()
      .from(workspaceModel)
      .where(
        and(
          eq(workspaceModel.id, config.workspaceId),
          eq(workspaceModel.tenantId, ROOT_TENANT_ID),
        ),
      )
      .limit(1)
    if (!workspace) {
      throw new Error("Shared workspace unavailable")
    }
    const accountId = `${config.issuer}|${identity.userId}`
    const [linked] = await tx
      .select()
      .from(accountModel)
      .where(
        and(
          eq(accountModel.providerId, PROVIDER),
          eq(accountModel.accountId, accountId),
          eq(accountModel.tenantId, ROOT_TENANT_ID),
        ),
      )
      .limit(1)
    let userId = linked?.userId
    if (
      !userId &&
      config.bootstrapSubject === identity.userId &&
      access.role === "admin"
    ) {
      const [ownerLink] = await tx
        .select()
        .from(accountModel)
        .where(
          and(
            eq(accountModel.userId, workspace.ownerId),
            eq(accountModel.providerId, PROVIDER),
          ),
        )
        .limit(1)
      if (ownerLink) {
        throw new Error("Workspace owner already bound")
      }
      userId = workspace.ownerId
      // Прежние браузерные сессии и пароль не должны наследовать новую личность.
      await tx.delete(sessionModel).where(eq(sessionModel.userId, userId))
      await tx
        .delete(accountModel)
        .where(
          and(
            eq(accountModel.userId, userId),
            eq(accountModel.providerId, "credential"),
          ),
        )
      // Привязка прежнего технического владельца разрешена только явным subject.
      await tx
        .update(userModel)
        .set({ email: identity.email, emailVerified: true })
        .where(eq(userModel.id, userId))
    }
    if (!userId) {
      const [existing] = await tx
        .select()
        .from(userModel)
        .where(
          and(
            eq(userModel.email, identity.email),
            eq(userModel.tenantId, ROOT_TENANT_ID),
          ),
        )
        .limit(1)
      if (existing) {
        throw new Error("Identity requires explicit administrator linking")
      }
      const [created] = await tx
        .insert(userModel)
        .values({
          email: identity.email,
          name: identity.email.split("@")[0],
          emailVerified: true,
          tenantId: ROOT_TENANT_ID,
        })
        .returning()
      userId = created.id
    }
    const [user] = await tx
      .select()
      .from(userModel)
      .where(
        and(eq(userModel.id, userId), eq(userModel.tenantId, ROOT_TENANT_ID)),
      )
      .limit(1)
    if (!user || user.email !== identity.email) {
      throw new Error("Identity mismatch")
    }
    if (!linked) {
      await tx.insert(accountModel).values({
        accountId,
        providerId: PROVIDER,
        userId,
        tenantId: ROOT_TENANT_ID,
      })
    }
    const [member] = await tx
      .select()
      .from(workspaceMemberModel)
      .where(
        and(
          eq(workspaceMemberModel.workspaceId, workspace.id),
          eq(workspaceMemberModel.userId, userId),
        ),
      )
      .limit(1)
    const owner = workspace.ownerId === userId
    if (owner && access.role !== "admin") {
      throw new Error("Workspace owner requires CRM administrator access")
    }
    const memberValues = {
      role: owner ? ("owner" as const) : ("agent" as const),
      permissions: { ...permissions, superAdmin: access.role === "admin" },
    }
    // Existing permissions are reconciled by authorizeSupaLoginSession through
    // the service, which invalidates membership caches and revokes realtime.
    // Updating them directly here would hide role changes from that comparison.
    if (!member) {
      await tx
        .insert(workspaceMemberModel)
        .values({ ...memberValues, workspaceId: workspace.id, userId })
    }
    return userId
  })
}

/** Выполняется при каждом чтении браузерной сессии; отзыв допуска CRM действует сразу. */
export async function authorizeSupaLoginSession(
  config: SupaLoginConfig,
  user: { id: string; email: string },
) {
  try {
    const [account] = await db
      .select()
      .from(accountModel)
      .where(
        and(
          eq(accountModel.userId, user.id),
          eq(accountModel.providerId, PROVIDER),
          eq(accountModel.tenantId, ROOT_TENANT_ID),
        ),
      )
      .limit(1)
    const prefix = `${config.issuer}|`
    if (!account?.accountId.startsWith(prefix)) {
      return false
    }
    const result = await checkCrmAccess(config, {
      userId: account.accountId.slice(prefix.length),
      email: user.email,
    })
    const [member] = await db
      .select()
      .from(workspaceMemberModel)
      .where(
        and(
          eq(workspaceMemberModel.workspaceId, config.workspaceId),
          eq(workspaceMemberModel.userId, user.id),
        ),
      )
      .limit(1)
    if (!member) {
      return false
    }
    const allowed =
      result.allowed && (member.role !== "owner" || result.role === "admin")
    const expected = allowed
      ? { ...permissions, superAdmin: result.role === "admin" }
      : {
          ...permissions,
          superAdmin: false,
          analytics: false,
          flows: false,
          contacts: false,
          emailAndPhone: false,
        }
    if (
      Object.entries(expected).some(
        ([key, value]) =>
          member.permissions[key as keyof typeof expected] !== value,
      )
    ) {
      await workspaceMemberService.update({
        id: member.id,
        workspaceId: config.workspaceId,
        data: { permissions: expected },
        revokeRealtime: true,
      })
    }
    return allowed
  } catch {
    return false
  }
}
