import { z } from "zod"

export const SOURCE_AUTHORING_BRIDGE_PROTOCOL =
  "supacrm.source-authoring-bridge.v1"
const responseSchema = z.strictObject({
  protocol: z.literal(SOURCE_AUTHORING_BRIDGE_PROTOCOL),
  requestId: z.string().min(1),
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
})
const requestPath =
  /^\/api\/automation\/bots\/[0-9a-f-]+\/source-runtime\/(projection|draft|compile|validate|publish|message-fields(?:\/(?:view|slot|compile))?)$/i

export function validateCrmOrigin(value: string): string {
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error("Неверный origin CRM")
  }
  return url.origin
}

/** Привязку registry UUID обеспечивает parent; iframe не управляет backend URL. */
export function createParentAuthoringFetch(
  crmOrigin: string,
  timeoutMs = 15_000,
): typeof fetch {
  const origin = validateCrmOrigin(crmOrigin)
  return (input, init) => {
    if (window.parent === window) {
      return Promise.reject(new Error("Нет родительской CRM"))
    }
    const path = typeof input === "string" ? input : ""
    const match = requestPath.exec(path)
    const actions = {
      projection: "load",
      draft: "save",
      compile: "compile",
      validate: "validate",
      publish: "publish",
      "message-fields": "message-fields",
      "message-fields/view": "message-view",
      "message-fields/slot": "message-slot",
      "message-fields/compile": "message-compile",
    } as const
    const suffix = match?.[1] as keyof typeof actions | undefined
    const action = suffix ? actions[suffix] : undefined
    if (
      !action ||
      ((action === "load" || action === "message-fields") &&
        init?.method !== "GET") ||
      (action === "save" && init?.method !== "PATCH") ||
      ((action === "compile" ||
        action === "validate" ||
        action === "publish" ||
        action === "message-view" ||
        action === "message-slot" ||
        action === "message-compile") &&
        init?.method !== "POST")
    ) {
      return Promise.reject(new Error("Неверное действие редактора"))
    }
    if (init?.signal?.aborted) {
      return Promise.reject(new Error("Запрос отменён"))
    }
    let body: unknown
    const readOnly = action === "load" || action === "message-fields"
    if (!readOnly) {
      try {
        body = JSON.parse(String(init?.body))
      } catch {
        return Promise.reject(new Error("Неверный authoring patch"))
      }
    }
    const requestId = crypto.randomUUID()
    return new Promise<Response>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener("message", receive)
        init?.signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        cleanup()
        reject(new Error("Запрос отменён"))
      }
      const receive = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== window.parent) {
          return
        }
        const parsed = responseSchema.safeParse(event.data)
        if (!parsed.success || parsed.data.requestId !== requestId) {
          return
        }
        try {
          const response = new Response(JSON.stringify(parsed.data.body), {
            status: parsed.data.status,
            headers: { "Content-Type": "application/json" },
          })
          cleanup()
          resolve(response)
        } catch {
          cleanup()
          reject(new Error("Неверный ответ CRM"))
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Ответ CRM не подтверждён"))
      }, timeoutMs)
      window.addEventListener("message", receive)
      init?.signal?.addEventListener("abort", abort, { once: true })
      // Только точный origin; нет '*', bearer token, runtime event и произвольного URL.
      window.parent.postMessage(
        {
          protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
          requestId,
          action,
          ...(readOnly ? {} : { body }),
        },
        origin,
      )
    })
  }
}
