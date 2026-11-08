// @vitest-environment node
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => ({ status: "ok", items: [] })),
  image: vi.fn(),
  workspaceAuth: vi.fn(),
  routes: new Map<
    string,
    {
      handler: (props: { input: { workspaceId: string } }) => Promise<unknown>
      guard?: unknown
      mapper?: (input: { workspaceId: string }) => string
    }
  >(),
}))
vi.mock("@/orpc", () => ({
  authorizedAPI: {
    route: ({ path }: { path: string }) => {
      const record = {
        handler: async (_props: { input: { workspaceId: string } }) =>
          undefined as unknown,
        guard: undefined as unknown,
        mapper: undefined as
          | ((input: { workspaceId: string }) => string)
          | undefined,
      }
      const chain = {
        input: () => chain,
        output: () => chain,
        use: (
          guard: unknown,
          mapper: (input: { workspaceId: string }) => string,
        ) => {
          record.guard = guard
          record.mapper = mapper
          return chain
        },
        handler: (handler: typeof record.handler) => {
          record.handler = handler
          mocks.routes.set(path, record)
          return record
        },
      }
      return chain
    },
  },
}))
vi.mock("@/middlewares/auth", () => ({
  workspaceAuthorizedMidddleware: mocks.workspaceAuth,
}))
vi.mock("@/features/flows/queries", () => ({ listFlows: vi.fn() }))
vi.mock("@chatbotx.io/analytics", async () => {
  const { z } = await import("zod")
  return {
    flowAnalyticsService: {},
    flowNodeStatsResponse: z.object({}),
    flowStatsRequest: z.object({}),
  }
})
vi.mock("@chatbotx.io/business", () => ({
  flowVersionService: {},
  messengerWelcomeMessageFlowService: {},
}))
vi.mock("@chatbotx.io/business/supacrm-catalog", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/business/supacrm-catalog")>()),
  supacrmCatalogService: { list: mocks.list, image: mocks.image },
}))

await import("../src/features/flows/api/private")

it("private picker uses session auth and workspace middleware before the shared service", async () => {
  const route = mocks.routes.get("/workspaces/{workspaceId}/flows/crm-catalog")
  expect(route?.guard).toBe(mocks.workspaceAuth)
  expect(route?.mapper?.({ workspaceId: "123" })).toBe("123")
  await route?.handler({ input: { workspaceId: "123" } })
  expect(mocks.list).toHaveBeenCalledWith({ workspaceId: "123" })
})
