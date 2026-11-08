import { createHash } from "node:crypto"
import { createId } from "@chatbotx.io/utils"
import { hashPassword } from "better-auth/crypto"
import { z } from "zod"
import { db, sql } from "../client"
import {
  accountModel,
  userModel,
  workspaceApiTokenModel,
  workspaceMemberModel,
  workspaceModel,
} from "../schema"

const bootstrapEnvironment = z.object({
  TEST_ADMIN_EMAIL: z.email().transform((value) => value.toLowerCase()),
  TEST_ADMIN_PASSWORD: z.string().min(16).max(128),
  TEST_WORKSPACE_TOKEN: z.string().regex(/^cbx_ws_[A-Za-z0-9_-]{43}$/),
})

/** Только первичная установка в отдельной тестовой БД; существующие данные не меняются. */
export async function bootstrapTestWorkspace(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ created: false } | { created: true; workspaceId: string }> {
  if (environment.RUN_TEST_BOOTSTRAP !== "true") {
    return { created: false }
  }
  return await db.transaction(async (tx) => {
    // Несколько одновременно стартующих реплик не создадут разные аккаунты.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(739102416)`)
    if (await tx.query.userModel.findFirst({ columns: { id: true } })) {
      return { created: false }
    }
    const parsed = bootstrapEnvironment.safeParse(environment)
    if (!parsed.success) {
      // Zod/SQL errors may contain input values; never expose credential material.
      throw new Error("Invalid TEST bootstrap environment")
    }
    const config = parsed.data
    const userId = createId()
    const workspaceId = createId()
    const password = await hashPassword(config.TEST_ADMIN_PASSWORD)
    await tx.insert(userModel).values({
      id: userId,
      email: config.TEST_ADMIN_EMAIL,
      name: "TEST SUPAcrm",
      emailVerified: true,
    })
    await tx.insert(accountModel).values({
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    })
    await tx.insert(workspaceModel).values({
      id: workspaceId,
      ownerId: userId,
      name: "TEST SUPAcrm",
      timezone: "Asia/Aqtau",
    })
    await tx.insert(workspaceMemberModel).values({
      workspaceId,
      userId,
      role: "owner",
      notificationChannels: {
        messenger: false,
        email: false,
        telegram: false,
        browser: true,
      },
      notificationTypes: {
        notifyAdmin: false,
        newMessageToHuman: false,
        newOrder: false,
      },
      permissions: {
        superAdmin: true,
        analytics: true,
        flows: true,
        contacts: true,
        onlyAssignedContacts: false,
        emailAndPhone: true,
        broadcast: true,
        ecommerce: true,
      },
    })
    await tx.insert(workspaceApiTokenModel).values({
      workspaceId,
      name: "SUPAcrm TEST provisioning",
      permission: "full",
      tokenHash: createHash("sha256")
        .update(config.TEST_WORKSPACE_TOKEN)
        .digest("hex"),
      tokenPrefix: config.TEST_WORKSPACE_TOKEN.slice(0, 12),
      isDefault: false,
    })
    return { created: true, workspaceId }
  })
}
