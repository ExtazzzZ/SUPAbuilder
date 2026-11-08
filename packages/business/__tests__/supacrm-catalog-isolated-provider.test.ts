import { afterEach, expect, it, vi } from "vitest"
import { supacrmCatalogService } from "../src/supacrm-catalog"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it("serves a visibly labelled synthetic catalog only through the explicit isolated provider", async () => {
  const item = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    title: "Synthetic receipt service",
    availability: "available",
    hasImage: false,
  }
  vi.stubEnv("SUPACRM_CATALOG_PROVIDER", "isolated_fixture")
  vi.stubEnv("SUPACRM_ISOLATED_TEST_MODE", "true")
  vi.stubEnv("SUPACRM_CATALOG_FIXTURE_JSON", JSON.stringify([item]))
  vi.stubEnv("SUPACRM_CATALOG_API_URL", "")
  const fetch = vi.fn(() => {
    throw new Error("Network is forbidden in the isolated provider")
  })
  vi.stubGlobal("fetch", fetch)
  const result = await supacrmCatalogService.list({ workspaceId: "1" })
  expect(result).toEqual({
    status: "ok",
    provider: "isolated_fixture",
    items: [item],
  })
  expect(
    await supacrmCatalogService.image({ workspaceId: "1", itemId: item.id }),
  ).toEqual({ status: "unavailable", dataUrl: null })
  expect(fetch).not.toHaveBeenCalled()
})

it("rejects fixture mode without its isolation flag and does not fall through to a real provider", async () => {
  vi.stubEnv("SUPACRM_CATALOG_PROVIDER", "isolated_fixture")
  vi.stubEnv("SUPACRM_ISOLATED_TEST_MODE", "false")
  vi.stubEnv("SUPACRM_CATALOG_FIXTURE_JSON", "[]")
  expect(await supacrmCatalogService.list({ workspaceId: "1" })).toEqual({
    status: "unavailable",
    provider: "isolated_fixture",
    items: [],
  })
})
