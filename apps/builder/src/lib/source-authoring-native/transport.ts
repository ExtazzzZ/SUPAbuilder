import type {
  NativeSourceAuthorization,
  NativeSourceTarget,
} from "./authorization"

const trailingSlash = /\/$/

const methods: Readonly<Record<string, string>> = Object.freeze({
  projection: "GET",
  draft: "PATCH",
  compile: "POST",
  validate: "POST",
  publish: "POST",
  "message-fields": "GET",
  "message-fields/view": "POST",
  "message-fields/slot": "POST",
  "message-fields/compile": "POST",
})
type Ports = {
  authorize(
    target: NativeSourceTarget,
  ): Promise<NativeSourceAuthorization | null>
  request(input: string, init: RequestInit): Promise<Response>
  builderOrigin: string
  apiBase: string
  apiKey: string
}
function denied(status: number, code: string) {
  return Response.json(
    { diagnostics: [{ code }], publishable: false, production: false },
    {
      status,
      headers: { "Cache-Control": "private, no-store" },
    },
  )
}

/** Только фиксированные authoring actions; без proxy исполнения/reveal/cutover. */
export async function forwardNativeSource(
  request: Request,
  target: NativeSourceTarget,
  action: string,
  ports: Ports,
): Promise<Response> {
  if (!Object.hasOwn(methods, action) || methods[action] !== request.method) {
    return denied(404, "source_route_not_found")
  }
  let base: URL
  try {
    const nativeOrigin = new URL(ports.builderOrigin).origin
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== nativeOrigin
    ) {
      return denied(403, "source_origin_denied")
    }
    base = new URL(ports.apiBase)
    if (
      !ports.apiKey ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !["https:", "http:"].includes(base.protocol) ||
      (base.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    ) {
      return denied(503, "source_transport_unavailable")
    }
  } catch {
    return denied(503, "source_transport_unavailable")
  }
  try {
    const authorization = await ports.authorize(target)
    if (!authorization) {
      return denied(403, "source_access_denied")
    }
    const body = request.method === "GET" ? undefined : await request.text()
    if (body !== undefined && new TextEncoder().encode(body).length > 262_144) {
      return denied(413, "source_request_too_large")
    }
    const endpoint = `${base.href.replace(trailingSlash, "")}/bots/${authorization.binding.registryId}/source-runtime/${action}`
    const response = await ports.request(endpoint, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "X-Automation-Key": ports.apiKey,
        "X-CRM-Actor": authorization.actor,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    })
    if (
      response.status !== 204 &&
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      return denied(502, "source_transport_unavailable")
    }
    return new Response(
      response.status === 204 ? null : await response.text(),
      {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch {
    return denied(502, "source_transport_unavailable")
  }
}
