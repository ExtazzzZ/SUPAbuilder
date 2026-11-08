import { createHash } from "node:crypto"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, test, vi } from "vitest"
import { supaLoginPlugin } from "../src/supalogin"
import {
  checkCrmAccess,
  getSupaLoginConfig,
  type SupaLoginConfig,
  safeSupaLoginReturnTo,
  supaLoginConfigSchema,
} from "../src/supalogin-config"

const config: SupaLoginConfig = {
  issuer: "https://login.example.test",
  clientId: "supabuilder",
  origin: "https://builder.example.test",
  accessUrl: "https://crm.example.test/api/auth/supabuilder/access",
  accessKey: "synthetic-crm-key-for-tests-only-123456",
  workspaceId: "42",
}
const identity = { userId: "identity-1", email: "member@example.test" }
const callbackUrl = `${config.origin}/api/auth/supalogin/callback`
const errorUrl = `${config.origin}/auth/sign-in?error=access_denied`
const defaultUrl = `${config.origin}/space/42/flows`
const FLOW_COOKIE = "__Host-supabuilder-oauth"

type Row = Record<string, unknown>
type Client = NonNullable<Parameters<typeof supaLoginPlugin>[1]["client"]>

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")

function setup() {
  const store = {
    user: [
      {
        id: "builder-user-1",
        email: identity.email,
        emailVerified: true,
        name: "Участник",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Row[],
    account: [] as Row[],
    session: [] as Row[],
    verification: [] as Row[],
  }
  let count = 0
  const authorize = vi.fn().mockImplementation(() => {
    count += 1
    return Promise.resolve({
      url: `${config.issuer}/authorize?state=state-${count}`,
      challenge: { state: `state-${count}`, verifier: `verifier-${count}` },
    })
  })
  const exchange = vi.fn().mockResolvedValue({
    err: false,
    tokens: { access: "synthetic-access-token" },
  })
  const verify = vi.fn().mockResolvedValue({
    err: false,
    aud: config.clientId,
    subject: { type: "user", properties: identity },
  })
  const provisionUser = vi.fn().mockResolvedValue("builder-user-1")
  const authorizeSession = vi.fn().mockResolvedValue(true)
  const auth = betterAuth({
    baseURL: config.origin,
    secret: "synthetic-session-secret-for-tests-only-123456789",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      supaLoginPlugin(config, {
        client: { authorize, exchange, verify } as unknown as Client,
        provisionUser,
        authorizeSession,
      }),
    ],
  })
  const request = (route: string, init?: RequestInit) =>
    auth.handler(new Request(`${config.origin}/api/auth${route}`, init))
  const start = async (returnTo?: string) => {
    const query = returnTo ? `?callbackURL=${encodeURIComponent(returnTo)}` : ""
    const response = await request(`/supalogin/start${query}`)
    const location = response.headers.get("location")
    expect(response.status).toBe(302)
    expect(location).not.toBeNull()
    const state = new URL(location as string).searchParams.get(
      "state",
    ) as string
    return { response, state, cookie: cookieHeader(response) }
  }
  const callback = (
    state: string,
    cookie?: string,
    extra = "code=valid-code",
  ) =>
    request(`/supalogin/callback?state=${encodeURIComponent(state)}&${extra}`, {
      headers: cookie ? { cookie } : {},
    })
  return {
    auth,
    store,
    request,
    start,
    callback,
    authorize,
    exchange,
    verify,
    provisionUser,
    authorizeSession,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("SUPAlogin через настоящий HTTP handler Better Auth и memoryAdapter", () => {
  test("start включает PKCE и хранит verifier только на сервере, а state в подписанной защищённой cookie", async () => {
    const fixture = setup()
    const { response, state, cookie } = await fixture.start(
      "/space/42/flows?folder=1",
    )
    expect(fixture.authorize).toHaveBeenCalledWith(callbackUrl, "code", {
      pkce: true,
      provider: "password",
    })
    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${FLOW_COOKIE}=`))
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("Secure")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).toContain("Path=/")
    expect(setCookie).toContain("Max-Age=600")
    expect(cookie).not.toContain("verifier-1")
    expect(cookie).not.toBe(`${FLOW_COOKIE}=${state}`)
    expect(fixture.store.verification).toHaveLength(1)
    const saved = fixture.store.verification[0]
    expect(saved.identifier).toBe(
      `supabuilder:${createHash("sha256").update(state).digest("hex")}`,
    )
    expect(JSON.parse(saved.value as string)).toEqual({
      verifier: "verifier-1",
      returnTo: "/space/42/flows?folder=1",
    })
    expect((saved.expiresAt as Date).getTime()).toBeGreaterThan(Date.now())
  })

  test("callback передаёт проверенную identity, выдаёт подписанную сессию и потребляет state один раз", async () => {
    const fixture = setup()
    const flow = await fixture.start("/space/42/flows?folder=1")
    const response = await fixture.callback(flow.state, flow.cookie)
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      `${config.origin}/space/42/flows?folder=1`,
    )
    expect(fixture.exchange).toHaveBeenCalledWith(
      "valid-code",
      callbackUrl,
      "verifier-1",
    )
    expect(fixture.verify).toHaveBeenCalledWith(
      expect.anything(),
      "synthetic-access-token",
    )
    expect(fixture.provisionUser).toHaveBeenCalledExactlyOnceWith(identity)
    expect(fixture.store.verification).toHaveLength(0)
    expect(fixture.store.session).toHaveLength(1)
    expect(
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${FLOW_COOKIE}=`)),
    ).toContain("Max-Age=0")
    const cookie = cookieHeader(response)
    const session = await fixture.request("/get-session", {
      headers: { cookie },
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      user: { id: "builder-user-1", email: identity.email },
    })
    expect(fixture.authorizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "builder-user-1", email: identity.email }),
    )
    const replay = await fixture.callback(flow.state, flow.cookie)
    expect(replay.headers.get("location")).toBe(errorUrl)
    expect(fixture.exchange).toHaveBeenCalledTimes(1)
    expect(fixture.store.session).toHaveLength(1)
  })

  test.each([
    "missing",
    "tampered",
    "other-browser",
  ])("callback отклоняет %s cookie до обмена кода", async (mode) => {
    const fixture = setup()
    const flow = await fixture.start()
    let cookie: string | undefined
    if (mode === "tampered") {
      cookie = `${FLOW_COOKIE}=${flow.state}.forged-signature`
    }
    if (mode === "other-browser") {
      cookie = (await fixture.start()).cookie
    }
    const response = await fixture.callback(flow.state, cookie)
    expect(response.headers.get("location")).toBe(errorUrl)
    expect(fixture.exchange).not.toHaveBeenCalled()
    expect(fixture.provisionUser).not.toHaveBeenCalled()
    expect(fixture.store.session).toHaveLength(0)
  })

  test.each([
    "bad-code",
    "bad-signature",
    "bad-audience",
    "wrong-subject",
    "crm-denied",
    "crm-unavailable",
  ])("callback закрывает доступ при %s и запрещает повтор state", async (reason) => {
    const fixture = setup()
    if (reason === "bad-code") {
      fixture.exchange.mockResolvedValue({ err: true })
    }
    if (reason === "bad-signature") {
      fixture.verify.mockResolvedValue({ err: true })
    }
    if (reason === "bad-audience") {
      fixture.verify.mockResolvedValue({
        err: false,
        aud: "other-app",
        subject: { type: "user", properties: identity },
      })
    }
    if (reason === "wrong-subject") {
      fixture.verify.mockResolvedValue({
        err: false,
        aud: config.clientId,
        subject: { type: "machine", properties: identity },
      })
    }
    if (reason === "crm-denied" || reason === "crm-unavailable") {
      fixture.provisionUser.mockRejectedValue(new Error(reason))
    }
    const flow = await fixture.start()
    const response = await fixture.callback(flow.state, flow.cookie)
    expect(response.headers.get("location")).toBe(errorUrl)
    expect(fixture.store.session).toHaveLength(0)
    expect(fixture.store.verification).toHaveLength(0)
    if (!reason.startsWith("crm-")) {
      expect(fixture.provisionUser).not.toHaveBeenCalled()
    }
    await fixture.callback(flow.state, flow.cookie)
    expect(fixture.exchange).toHaveBeenCalledTimes(1)
  })

  test.each([
    "expired",
    "provider-error",
    "missing-code",
  ])("%s flow не обменивает код и не создаёт сессию", async (reason) => {
    const fixture = setup()
    const flow = await fixture.start()
    if (reason === "expired") {
      fixture.store.verification[0].expiresAt = new Date(Date.now() - 1)
    }
    const queries: Record<string, string> = {
      "provider-error": "code=x&error=denied",
      "missing-code": "",
      expired: "code=x",
    }
    const response = await fixture.callback(
      flow.state,
      flow.cookie,
      queries[reason],
    )
    expect(response.headers.get("location")).toBe(errorUrl)
    expect(fixture.exchange).not.toHaveBeenCalled()
    expect(fixture.store.session).toHaveLength(0)
  })

  test("внешний callbackURL возвращает пользователя в общий workspace", async () => {
    const fixture = setup()
    const flow = await fixture.start("https://attacker.example.test/collect")
    expect(
      (await fixture.callback(flow.state, flow.cookie)).headers.get("location"),
    ).toBe(defaultUrl)
  })

  test("get-session повторно проверяет CRM и скрывает ранее действовавшую сессию после отзыва", async () => {
    const fixture = setup()
    const flow = await fixture.start()
    const cookie = cookieHeader(await fixture.callback(flow.state, flow.cookie))
    const first = await fixture.request("/get-session", { headers: { cookie } })
    expect(await first.json()).toMatchObject({ user: { id: "builder-user-1" } })
    fixture.authorizeSession.mockResolvedValue(false)
    const revoked = await fixture.request("/get-session", {
      headers: { cookie },
    })
    expect(await revoked.json()).toBeNull()
    expect(fixture.authorizeSession).toHaveBeenCalledTimes(2)
    expect(
      await fixture.auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull()
  })

  test("неподписанный токен существующей сессии не принимается", async () => {
    const fixture = setup()
    const flow = await fixture.start()
    const response = await fixture.callback(flow.state, flow.cookie)
    const sessionCookie = response.headers
      .getSetCookie()
      .find((value) => value.includes("session_token="))
    expect(sessionCookie).toBeDefined()
    const name = sessionCookie?.split("=")[0]
    const forged = `${name}=${fixture.store.session[0].token}`
    const session = await fixture.request("/get-session", {
      headers: { cookie: forged },
    })
    expect(await session.json()).toBeNull()
    expect(fixture.authorizeSession).not.toHaveBeenCalled()
  })

  test.each([
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
  ])("локальный маршрут %s запрещён даже когда emailAndPassword включён", async (route) => {
    const fixture = setup()
    const response = await fixture.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.origin },
      body: JSON.stringify({
        email: identity.email,
        password: "synthetic-password",
        name: "Локальный пользователь",
      }),
    })
    expect(response.status).toBe(403)
    expect(fixture.store.session).toHaveLength(0)
    expect(fixture.store.user).toHaveLength(1)
  })
})

describe("конфигурация SUPAlogin и серверная проверка CRM", () => {
  test.each([
    undefined,
    "https://evil.example.test",
    "//evil.example.test",
    "/space/420/flows",
    "/space/43/flows",
    "/auth/sign-in",
    "https://user:password@builder.example.test/space/42/flows",
  ])("небезопасный returnTo %s заменяется общим workspace", (target) => {
    expect(safeSupaLoginReturnTo(target, config)).toBe("/space/42/flows")
  })

  test("внутренний путь текущего workspace сохраняет query и hash", () => {
    expect(
      safeSupaLoginReturnTo("/space/42/flows?folder=7#details", config),
    ).toBe("/space/42/flows?folder=7#details")
  })

  test.each([
    "issuer",
    "origin",
    "accessUrl",
  ] as const)("HTTP %s не допускается", (key) => {
    expect(
      supaLoginConfigSchema.safeParse({
        ...config,
        [key]: "http://example.test",
      }).success,
    ).toBe(false)
  })

  test("режим отключён без issuer; включённый режим требует полной конфигурации", () => {
    vi.stubEnv("SUPALOGIN_ISSUER", "")
    expect(getSupaLoginConfig()).toBeNull()
    vi.stubEnv("SUPALOGIN_ISSUER", config.issuer)
    vi.stubEnv("SUPABUILDER_ACCESS_KEY", "")
    expect(() => getSupaLoginConfig()).toThrow()
  })

  test("CRM получает verified identity и server key без кеширования и перенаправлений", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ allowed: true, role: "member" }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await checkCrmAccess(config, identity)).toEqual({
      allowed: true,
      role: "member",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      config.accessUrl,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
        headers: {
          Authorization: `Bearer ${config.accessKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(identity),
      }),
    )
  })

  test("CRM allowed:false остаётся отказом, даже для роли admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ allowed: false, role: "admin" })),
    )
    expect(await checkCrmAccess(config, identity)).toEqual({
      allowed: false,
      role: "admin",
    })
  })

  test.each([
    401, 403, 503,
  ])("HTTP %s от CRM не даёт положительный результат", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ allowed: true, role: "admin" }, { status }),
        ),
    )
    await expect(checkCrmAccess(config, identity)).rejects.toThrow(
      "CRM access check unavailable",
    )
  })

  test.each([
    { allowed: "true", role: "member" },
    { allowed: true },
    { allowed: true, role: "owner" },
  ])("невалидный ответ CRM %j отклоняется", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)))
    await expect(checkCrmAccess(config, identity)).rejects.toThrow()
  })

  test("сетевой отказ CRM пробрасывается для закрытого отказа вызывающего слоя", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unavailable")),
    )
    await expect(checkCrmAccess(config, identity)).rejects.toThrow(
      "Network unavailable",
    )
  })
})
