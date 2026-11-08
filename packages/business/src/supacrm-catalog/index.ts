import { z } from "zod"
import { checkSsrfSafety } from "../net/ssrf-guard"

const TRAILING_SLASH = /\/$/
const statusSchema = z.enum(["ok", "not_configured", "unavailable"])
export const supacrmCatalogItemSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(255),
  availability: z.enum(["available", "request", "paused"]),
  hasImage: z.boolean(),
})
export const supacrmCatalogResponseSchema = z.object({
  status: statusSchema,
  provider: z.literal("isolated_fixture").optional(),
  items: z.array(supacrmCatalogItemSchema),
})
export const supacrmCatalogImageSchema = z.object({
  status: statusSchema,
  dataUrl: z.string().nullable(),
})
export type SupacrmCatalogItem = z.infer<typeof supacrmCatalogItemSchema>
const sourceSchema = z
  .array(
    z.object({
      id: z.uuid(),
      title: z.string().min(1).max(255),
      availability: z
        .enum(["available", "request", "paused"])
        .default("request"),
      archived: z.boolean().default(false),
      has_image: z.boolean().default(false),
    }),
  )
  .max(5000)

async function configuration() {
  const configured = process.env.SUPACRM_CATALOG_API_URL
  if (!configured) {
    return null
  }
  const url = new URL(configured)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(TRAILING_SLASH, "") !== "/api/v1/catalog"
  ) {
    throw new Error("Invalid catalog configuration")
  }
  url.pathname = url.pathname.replace(TRAILING_SLASH, "")
  if ((await checkSsrfSafety(url.href)).unsafe) {
    throw new Error("Unsafe catalog configuration")
  }
  const excluded = z
    .array(z.uuid())
    .parse(JSON.parse(process.env.SUPACRM_CATALOG_EXCLUDED_IDS || "[]"))
  const headers: Record<string, string> = {}
  const key = process.env.SUPACRM_CATALOG_API_KEY
  if (key) {
    headers["X-Catalog-Key"] = key
  }
  return {
    url,
    excluded: new Set(excluded),
    headers,
    includeArchived: process.env.SUPACRM_CATALOG_INCLUDE_ARCHIVED === "true",
  }
}

async function request(
  url: string,
  headers: Record<string, string>,
  maximum: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  })
  if (!(response.ok && response.body)) {
    throw new Error("Catalog unavailable")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    length += chunk.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error("Catalog too large")
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, contentType: response.headers.get("content-type") || "" }
}

async function visibleRows(
  config: NonNullable<Awaited<ReturnType<typeof configuration>>>,
) {
  const { bytes } = await request(
    config.url.href,
    { ...config.headers, Accept: "application/json" },
    2_000_000,
  )
  return sourceSchema
    .parse(JSON.parse(new TextDecoder().decode(bytes)))
    .filter(
      (row) =>
        !config.excluded.has(row.id) &&
        (!row.archived || config.includeArchived),
    )
}

/** Источник общий публичный каталог; auth/workspace boundary применяется обоими API до сервиса. */
export const supacrmCatalogService = {
  async list({
    workspaceId,
  }: {
    workspaceId: string
  }): Promise<z.infer<typeof supacrmCatalogResponseSchema>> {
    if (!workspaceId) {
      throw new Error("Workspace required")
    }
    // Явный test provider заменяет только внешний feed. HTTP/SSRF policy не меняется.
    if (process.env.SUPACRM_CATALOG_PROVIDER === "isolated_fixture") {
      try {
        if (process.env.SUPACRM_ISOLATED_TEST_MODE !== "true") {
          throw new Error("Isolated test mode required")
        }
        const raw = process.env.SUPACRM_CATALOG_FIXTURE_JSON || ""
        if (raw.length > 2_000_000) {
          throw new Error("Fixture too large")
        }
        const items = z
          .array(
            supacrmCatalogItemSchema.extend({ hasImage: z.literal(false) }),
          )
          .max(5000)
          .parse(JSON.parse(raw))
        return { status: "ok", provider: "isolated_fixture", items }
      } catch {
        return {
          status: "unavailable",
          provider: "isolated_fixture",
          items: [],
        }
      }
    }
    try {
      const config = await configuration()
      if (!config) {
        return { status: "not_configured", items: [] }
      }
      const rows = await visibleRows(config)
      return {
        status: "ok",
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          availability: row.archived ? "paused" : row.availability,
          hasImage: row.has_image,
        })),
      }
    } catch {
      // Не возвращаем URL конфигурации, ключ, тело upstream или текст исключения.
      return { status: "unavailable", items: [] }
    }
  },
  async image({
    workspaceId,
    itemId,
  }: {
    workspaceId: string
    itemId: string
  }): Promise<z.infer<typeof supacrmCatalogImageSchema>> {
    if (!workspaceId) {
      throw new Error("Workspace required")
    }
    if (process.env.SUPACRM_CATALOG_PROVIDER === "isolated_fixture") {
      return { status: "unavailable", dataUrl: null }
    }
    try {
      const id = z.uuid().parse(itemId)
      const config = await configuration()
      if (!config) {
        return { status: "not_configured", dataUrl: null }
      }
      if (config.excluded.has(id)) {
        return { status: "unavailable", dataUrl: null }
      }
      if (
        !(await visibleRows(config)).some(
          (row) => row.id === id && row.has_image,
        )
      ) {
        return { status: "unavailable", dataUrl: null }
      }
      const { bytes, contentType } = await request(
        `${config.url.href}/${id}/image`,
        { ...config.headers, Accept: "image/webp" },
        1_500_000,
      )
      const signature = new TextDecoder().decode(bytes.slice(0, 12))
      if (
        !contentType.startsWith("image/webp") ||
        bytes.byteLength < 12 ||
        !signature.startsWith("RIFF") ||
        signature.slice(8, 12) !== "WEBP"
      ) {
        throw new Error("Invalid image")
      }
      return {
        status: "ok",
        dataUrl: `data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`,
      }
    } catch {
      return { status: "unavailable", dataUrl: null }
    }
  },
}
