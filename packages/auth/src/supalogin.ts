import { createClient } from "@openauthjs/openauth/client"
import { createSubjects } from "@openauthjs/openauth/subject"
import { APIError, type BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { z } from "zod"
import {
  type SupaLoginConfig,
  type SupaLoginIdentity,
  safeSupaLoginReturnTo,
} from "./supalogin-config"

const subjects = createSubjects({
  user: z.object({ userId: z.string().min(1), email: z.email() }),
})
const stateSchema = z.object({ verifier: z.string(), returnTo: z.string() })
const FLOW_COOKIE = "__Host-supabuilder-oauth"
const FLOW_TTL = 600
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: FLOW_TTL,
}
const stateKey = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return `supabuilder:${hash}`
}
const allowedAuthPaths = new Set([
  "/supalogin/start",
  "/supalogin/callback",
  "/get-session",
  "/sign-out",
])

type Dependencies = {
  provisionUser: (identity: SupaLoginIdentity) => Promise<string>
  authorizeSession: (user: { id: string; email: string }) => Promise<boolean>
  client?: ReturnType<typeof createClient>
}

export function supaLoginPlugin(
  config: SupaLoginConfig,
  dependencies: Dependencies,
): BetterAuthPlugin {
  const client =
    dependencies.client ??
    createClient({ clientID: config.clientId, issuer: config.issuer })
  const callback = new URL(
    "/api/auth/supalogin/callback",
    config.origin,
  ).toString()
  const errorUrl = new URL(
    "/auth/sign-in?error=access_denied",
    config.origin,
  ).toString()
  return {
    id: "supabuilder-supalogin",
    hooks: {
      before: [
        {
          matcher: (ctx) => !allowedAuthPaths.has(ctx.path ?? ""),
          handler: createAuthMiddleware(() => {
            throw new APIError("FORBIDDEN", { message: "Use SUPAlogin" })
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const result = ctx.context.returned as {
              user?: { id: string; email: string }
            } | null
            if (
              result?.user &&
              !(await dependencies.authorizeSession(result.user))
            ) {
              return ctx.json(null)
            }
          }),
        },
      ],
    },
    endpoints: {
      supaLoginStart: createAuthEndpoint(
        "/supalogin/start",
        {
          method: "GET",
          query: z.object({ callbackURL: z.string().optional() }),
        },
        async (ctx) => {
          const authorization = await client.authorize(callback, "code", {
            pkce: true,
            provider: "password",
          })
          if (!authorization.challenge.verifier) {
            throw new APIError("INTERNAL_SERVER_ERROR")
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: await stateKey(authorization.challenge.state),
            value: JSON.stringify({
              verifier: authorization.challenge.verifier,
              returnTo: safeSupaLoginReturnTo(ctx.query.callbackURL, config),
            }),
            expiresAt: new Date(Date.now() + FLOW_TTL * 1000),
          })
          await ctx.setSignedCookie(
            FLOW_COOKIE,
            authorization.challenge.state,
            ctx.context.secret,
            cookieOptions,
          )
          throw ctx.redirect(authorization.url)
        },
      ),
      supaLoginCallback: createAuthEndpoint(
        "/supalogin/callback",
        {
          method: "GET",
          query: z.object({
            state: z.string().optional(),
            code: z.string().optional(),
            error: z.string().optional(),
          }),
        },
        async (ctx) => {
          const browserState = await ctx.getSignedCookie(
            FLOW_COOKIE,
            ctx.context.secret,
          )
          ctx.setCookie(FLOW_COOKIE, "", { ...cookieOptions, maxAge: 0 })
          if (!ctx.query.state || browserState !== ctx.query.state) {
            throw ctx.redirect(errorUrl)
          }
          const flow =
            await ctx.context.internalAdapter.consumeVerificationValue(
              await stateKey(ctx.query.state),
            )
          if (
            !flow ||
            flow.expiresAt.getTime() <= Date.now() ||
            !ctx.query.code ||
            ctx.query.error
          ) {
            throw ctx.redirect(errorUrl)
          }
          let userId: string
          let returnTo: string
          try {
            const saved = stateSchema.parse(JSON.parse(flow.value))
            returnTo = safeSupaLoginReturnTo(saved.returnTo, config)
            const exchanged = await client.exchange(
              ctx.query.code,
              callback,
              saved.verifier,
            )
            if (exchanged.err) {
              throw new Error("Code rejected")
            }
            const verified = await client.verify(
              subjects,
              exchanged.tokens.access,
            )
            if (
              verified.err ||
              verified.aud !== config.clientId ||
              verified.subject.type !== "user"
            ) {
              throw new Error("Token rejected")
            }
            userId = await dependencies.provisionUser(
              verified.subject.properties,
            )
          } catch {
            throw ctx.redirect(errorUrl)
          }
          const user = await ctx.context.internalAdapter.findUserById(userId)
          if (!user) {
            throw ctx.redirect(errorUrl)
          }
          const session =
            await ctx.context.internalAdapter.createSession(userId)
          if (!session) {
            throw ctx.redirect(errorUrl)
          }
          await setSessionCookie(ctx, { session, user })
          throw ctx.redirect(new URL(returnTo, config.origin).toString())
        },
      ),
    },
  }
}
