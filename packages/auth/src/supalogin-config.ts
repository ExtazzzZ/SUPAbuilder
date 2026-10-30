import { z } from "zod"

const trailingSlash = /\/$/

export const supaLoginConfigSchema = z.object({
  issuer: z.url().refine((url) => new URL(url).protocol === "https:"),
  clientId: z.string().min(1),
  origin: z.url().refine((url) => new URL(url).protocol === "https:"),
  accessUrl: z.url().refine((url) => new URL(url).protocol === "https:"),
  accessKey: z.string().min(32),
  workspaceId: z.string().regex(/^\d+$/),
  bootstrapSubject: z.string().optional(),
})
export type SupaLoginConfig = z.infer<typeof supaLoginConfigSchema>
export type SupaLoginIdentity = { userId: string; email: string }

/** Отдельный адаптер SUPAlogin; generic OAuth и лицензионные gates не меняются. */
export function getSupaLoginConfig(): SupaLoginConfig | null {
  if (!process.env.SUPALOGIN_ISSUER) {
    return null
  }
  return supaLoginConfigSchema.parse({
    issuer: process.env.SUPALOGIN_ISSUER.replace(trailingSlash, ""),
    clientId: process.env.SUPALOGIN_CLIENT_ID || "supabuilder",
    origin: process.env.NEXT_PUBLIC_BUILDER_URL,
    accessUrl: process.env.SUPACRM_ACCESS_URL,
    accessKey: process.env.SUPABUILDER_ACCESS_KEY,
    workspaceId: process.env.SUPABUILDER_WORKSPACE_ID,
    bootstrapSubject: process.env.SUPALOGIN_BOOTSTRAP_SUBJECT,
  })
}

export function safeSupaLoginReturnTo(
  value: string | undefined,
  config: SupaLoginConfig,
): string {
  const fallback = `/space/${config.workspaceId}/flows`
  if (!value) {
    return fallback
  }
  try {
    const target = new URL(value, config.origin)
    if (
      target.origin !== new URL(config.origin).origin ||
      target.username ||
      target.password
    ) {
      return fallback
    }
    // Общий workspace; исключает повторный вход и переход в чужое пространство.
    const prefix = `/space/${config.workspaceId}`
    if (
      target.pathname !== prefix &&
      !target.pathname.startsWith(`${prefix}/`)
    ) {
      return fallback
    }
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}

const accessSchema = z.object({
  allowed: z.boolean(),
  role: z.enum(["admin", "member"]),
})
export async function checkCrmAccess(
  config: SupaLoginConfig,
  identity: SupaLoginIdentity,
) {
  const response = await fetch(config.accessUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(identity),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error("CRM access check unavailable")
  }
  return accessSchema.parse(await response.json())
}
