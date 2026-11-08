import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/net/ssrf-guard", () => ({
  checkSsrfSafety: vi.fn(async () => ({ unsafe: false })),
}))

import { checkSsrfSafety } from "../src/net/ssrf-guard"
import { supacrmCatalogService } from "../src/supacrm-catalog"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe("Server-only каталог CRM", () => {
  it("архивное изображение доступно только при явном preview-флаге", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
    const id = "123e4567-e89b-42d3-a456-426614174000"
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).endsWith("/image")
        ? new Response(Buffer.from("RIFF0000WEBPtest"), {
            headers: { "Content-Type": "image/webp" },
          })
        : Response.json([
            { id, title: "Архивный товар", archived: true, has_image: true },
          ]),
    )
    vi.stubGlobal("fetch", fetcher)
    vi.stubEnv("SUPACRM_CATALOG_INCLUDE_ARCHIVED", "false")
    expect(
      (await supacrmCatalogService.image({ workspaceId: "123", itemId: id }))
        .dataUrl,
    ).toBeNull()
    expect(
      fetcher.mock.calls.every(([url]) => !String(url).endsWith("/image")),
    ).toBe(true)
    vi.stubEnv("SUPACRM_CATALOG_INCLUDE_ARCHIVED", "true")
    expect(
      (await supacrmCatalogService.image({ workspaceId: "123", itemId: id }))
        .status,
    ).toBe("ok")
  })
  it("preview явно включает архивные позиции как paused, отсутствие статуса закрыто request", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
    const id = "123e4567-e89b-42d3-a456-426614174000"
    const other = "123e4567-e89b-42d3-a456-426614174001"
    const fetcher = vi.fn(async () =>
      Response.json([
        { id, title: "Архив", archived: true, has_image: true },
        { id: other, title: "Статус не подтверждён" },
      ]),
    )
    vi.stubGlobal("fetch", fetcher)
    vi.stubEnv("SUPACRM_CATALOG_INCLUDE_ARCHIVED", "false")
    expect(
      (await supacrmCatalogService.list({ workspaceId: "123" })).items,
    ).toEqual([
      {
        id: other,
        title: "Статус не подтверждён",
        availability: "request",
        hasImage: false,
      },
    ])
    vi.stubEnv("SUPACRM_CATALOG_INCLUDE_ARCHIVED", "true")
    const result = await supacrmCatalogService.list({ workspaceId: "123" })
    expect(result.items).toHaveLength(2)
    expect(result.items.find((item) => item.id === id)?.availability).toBe(
      "paused",
    )
  })
  it("без настройки не делает запрос и не выдумывает товары", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    expect(await supacrmCatalogService.list({ workspaceId: "123" })).toEqual({
      status: "not_configured",
      items: [],
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("запрашивает только server URL и возвращает безопасный текущий список", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
    const id = "123e4567-e89b-42d3-a456-426614174000"
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          id,
          title: "ChatGPT",
          availability: "request",
          has_image: true,
          archived: false,
          tariffs: [{ amount: "20" }],
          secret: "never-output",
        },
      ]),
    )
    vi.stubGlobal("fetch", fetcher)
    expect(await supacrmCatalogService.list({ workspaceId: "123" })).toEqual({
      status: "ok",
      items: [
        {
          id,
          title: "ChatGPT",
          availability: "request",
          hasImage: true,
        },
      ],
    })
    expect(fetcher).toHaveBeenCalledWith(
      "https://crm.example/api/v1/catalog",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
    )
  })
  it("не возвращает provider body при ошибке и отклоняет URL с credentials", async () => {
    vi.stubEnv(
      "SUPACRM_CATALOG_API_URL",
      "https://key:secret@crm.example/api/v1/catalog",
    )
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    expect(await supacrmCatalogService.list({ workspaceId: "123" })).toEqual({
      status: "unavailable",
      items: [],
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("ключ передаётся только upstream, исключённые позиции скрываются", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
    vi.stubEnv("SUPACRM_CATALOG_API_KEY", "synthetic-server-key")
    const id = "123e4567-e89b-42d3-a456-426614174000"
    vi.stubEnv("SUPACRM_CATALOG_EXCLUDED_IDS", JSON.stringify([id]))
    const fetcher = vi.fn(async () =>
      Response.json([{ id, title: "Тестовая позиция", has_image: true }]),
    )
    vi.stubGlobal("fetch", fetcher)
    const result = await supacrmCatalogService.list({ workspaceId: "123" })
    expect(result.items).toEqual([])
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      "X-Catalog-Key": "synthetic-server-key",
    })
    expect(JSON.stringify(result)).not.toContain("synthetic-server-key")
  })
  it("изображение отдаётся из server boundary без ключа или remote URL", async () => {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
    vi.stubEnv("SUPACRM_CATALOG_API_KEY", "synthetic-server-key")
    const id = "123e4567-e89b-42d3-a456-426614174000"
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).endsWith("/image")
        ? new Response(Buffer.from("RIFF0000WEBPtest"), {
            headers: { "Content-Type": "image/webp" },
          })
        : Response.json([{ id, title: "Товар", has_image: true }]),
    )
    vi.stubGlobal("fetch", fetcher)
    const result = await supacrmCatalogService.image({
      workspaceId: "123",
      itemId: id,
    })
    expect(result).toEqual({
      status: "ok",
      dataUrl: `data:image/webp;base64,${Buffer.from("RIFF0000WEBPtest").toString("base64")}`,
    })
    expect(JSON.stringify(result)).not.toContain("synthetic-server-key")
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      "X-Catalog-Key": "synthetic-server-key",
    })
  })
})

it("upstream errors remain unavailable without leaking response bodies", async () => {
  vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
  for (const response of [
    new Response("private body", { status: 503 }),
    new Response("not-json"),
    new Response("x".repeat(2_000_001)),
    new Response(null),
    Response.json([{ id: "not-a-uuid" }]),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    )
    expect(await supacrmCatalogService.list({ workspaceId: "123" })).toEqual({
      status: "unavailable",
      items: [],
    })
  }
})
it("unsafe configuration and SSRF cannot reach the upstream", async () => {
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  for (const url of [
    "http://crm.example/api/v1/catalog",
    "https://crm.example/wrong",
    "https://crm.example/api/v1/catalog?token=x",
  ]) {
    vi.stubEnv("SUPACRM_CATALOG_API_URL", url)
    expect(
      (await supacrmCatalogService.list({ workspaceId: "123" })).status,
    ).toBe("unavailable")
  }
  vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
  vi.mocked(checkSsrfSafety).mockResolvedValueOnce({ unsafe: true })
  expect(
    (await supacrmCatalogService.list({ workspaceId: "123" })).status,
  ).toBe("unavailable")
  expect(fetcher).not.toHaveBeenCalled()
})
it("invalid and excluded images do not reveal a key or source URL", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000"
  vi.stubEnv("SUPACRM_CATALOG_API_URL", "")
  expect(
    await supacrmCatalogService.image({ workspaceId: "123", itemId: id }),
  ).toEqual({ status: "not_configured", dataUrl: null })
  vi.stubEnv("SUPACRM_CATALOG_API_URL", "https://crm.example/api/v1/catalog")
  vi.stubEnv("SUPACRM_CATALOG_EXCLUDED_IDS", JSON.stringify([id]))
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  expect(
    (await supacrmCatalogService.image({ workspaceId: "123", itemId: id }))
      .status,
  ).toBe("unavailable")
  expect(
    (
      await supacrmCatalogService.image({
        workspaceId: "123",
        itemId: "../../other",
      })
    ).status,
  ).toBe("unavailable")
  expect(fetcher).not.toHaveBeenCalled()
  vi.stubEnv("SUPACRM_CATALOG_EXCLUDED_IDS", "[]")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<svg/>")),
  )
  expect(
    (await supacrmCatalogService.image({ workspaceId: "123", itemId: id }))
      .dataUrl,
  ).toBeNull()
  await expect(
    supacrmCatalogService.image({ workspaceId: "", itemId: id }),
  ).rejects.toThrow()
  await expect(
    supacrmCatalogService.list({ workspaceId: "" }),
  ).rejects.toThrow()
})
