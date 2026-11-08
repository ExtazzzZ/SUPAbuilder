// @vitest-environment node

import {
  createSupacrmCheckoutNode,
  createSupacrmFulfillmentNode,
  createSupacrmProductNode,
  selectSupacrmProduct,
  withSupacrmTariffSelection,
} from "@chatbotx.io/flow-config"
import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { beforeEach, expect, test, vi } from "vitest"

const {
  findWorkspaceByTokenHash,
  isWorkspaceScheduledForDeletion,
  getAccessState,
  isAtLimit,
  assertApiNotRateLimited,
  listNodes,
  catalogList,
  findFlow,
  authoringContext,
  write,
} = vi.hoisted(() => ({
  findWorkspaceByTokenHash: vi.fn(),
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  isAtLimit: vi.fn().mockResolvedValue(false),
  assertApiNotRateLimited: vi.fn().mockResolvedValue(undefined),
  listNodes: vi.fn(),
  catalogList: vi.fn(),
  findFlow: vi.fn(),
  authoringContext: vi.fn(),
  write: vi.fn(),
}))

vi.mock("@chatbotx.io/business/supacrm-catalog", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/business/supacrm-catalog")>()),
  supacrmCatalogService: { list: catalogList },
}))

vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: { findWorkspaceByTokenHash },
  isWorkspaceScheduledForDeletion,
  userQuotaService: { getAccessState },
  quotaEnforcementService: { isAtLimit },
  flowService: { listNodes, findById: findFlow, createDraft: write },
  flowVersionService: { publish: write, updateDraftByFlowId: write },
}))

vi.mock("@chatbotx.io/business/capabilities", () => ({
  getFlowAuthoringContext: authoringContext,
}))

vi.mock("@/features/flows/api/fulfillment-status", () => ({
  publicFulfillmentStatus: {},
}))

vi.mock("@/features/flows/api/receipt-email-template", () => ({
  receiptEmailTemplatePublicRouter: {},
}))

vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/rate-limit/api-rate-limit", () => ({
  assertApiNotRateLimited,
}))

vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))

vi.mock("@/env", () => ({ isCloud: () => true }))

vi.mock("@/middlewares/auth", () => ({
  authMiddleware: vi.fn(),
  workspaceAuthorizedMidddleware: vi.fn(),
}))

// Dynamic import: `vi.mock` is hoisted and only an import after registration
// resolves to the mocked modules.
const { flowsPublicRouter } = await import("../src/features/flows/api/public")

const FIXTURE_API_TOKEN = "cbx_ws_fixture"

const authResult = (scopes: string[] | null) => ({
  workspace: { id: "ws-1", ownerId: "owner-1" },
  apiToken: { id: "token-1", permission: "full" as const, scopes },
})

beforeEach(() => {
  vi.clearAllMocks()
  isWorkspaceScheduledForDeletion.mockReturnValue(false)
  getAccessState.mockResolvedValue({ blocked: false })
  isAtLimit.mockResolvedValue(false)
  assertApiNotRateLimited.mockResolvedValue(undefined)
})

const http = new OpenAPIHandler({ validate: flowsPublicRouter.validate })
const legacy = {
  spec: {
    formatVersion: 1,
    name: "Legacy",
    steps: [{ type: "send", text: "Hello" }],
  },
}
const nativeGraph = () => {
  const nodes = [
    withSupacrmTariffSelection(
      selectSupacrmProduct(
        createSupacrmProductNode({ nodeProps: { id: "101" } }),
        "00000000-0000-4000-8000-000000000001",
      ),
      true,
    ),
    ...(["offer", "receipt", "link", "wait"] as const).map((kind, i) =>
      createSupacrmCheckoutNode({ nodeProps: { id: String(102 + i) } }, kind),
    ),
    createSupacrmFulfillmentNode({ nodeProps: { id: "106" } }, "execute"),
    createSupacrmFulfillmentNode({ nodeProps: { id: "107" } }, "issue"),
  ]
  return {
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({
      id: `edge-${index}`,
      source: node.id,
      sourceHandle: node.data.details.quickReplies[0]?.id ?? node.id,
      target: nodes[index + 1].id,
      targetHandle: nodes[index + 1].id,
    })),
  }
}
const post = async (body: unknown, authorized = true) => {
  const { response } = await http.handle(
    new Request("http://localhost/v1/flows/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { Authorization: `Bearer ${FIXTURE_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      context: {
        headers: new Headers(
          authorized ? { Authorization: `Bearer ${FIXTURE_API_TOKEN}` } : {},
        ),
      },
    },
  )
  if (!response) {
    throw new Error("Route did not match")
  }
  return { status: response.status, body: await response.json() }
}
beforeEach(() => {
  findWorkspaceByTokenHash.mockResolvedValue(authResult(["automation"]))
  authoringContext.mockResolvedValue({
    templatesByName: new Map(),
    customFieldsByName: new Map(),
    flowsByName: new Map(),
  })
})

test("native full RAW graph validates through the public HTTP procedure without authoring lookup or writes", async () => {
  const graph = nativeGraph()
  const result = await post({ graph })
  expect(result.status).toBe(200)
  expect(result.body.nodes.map((n: { id: string }) => n.id)).toEqual([
    "101",
    "102",
    "103",
    "104",
    "105",
    "106",
    "107",
  ])
  expect(result.body.nodes[1].data.details.supacrmCheckout.kind).toBe("offer")
  expect(result.body.nodes[5].data.details.supacrmFulfillment.strategy).toBe(
    "apple_code_us_v1",
  )
  expect(
    result.body.edges.map((edge: { source: string; target: string }) => [
      edge.source,
      edge.target,
    ]),
  ).toEqual([
    ["101", "102"],
    ["102", "103"],
    ["103", "104"],
    ["104", "105"],
    ["105", "106"],
    ["106", "107"],
  ])
  expect(result.body.edges[0].sourceHandle).toBe(
    graph.nodes[0].data.details.quickReplies[0].id,
  )
  expect(authoringContext).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

test.each([
  "settings",
  "ports",
  "core",
  "edge core",
  "fulfillment ports",
  "product",
  "fulfillment",
])("native %s corruption is rejected by publish validation", async (mutation) => {
  const graph = nativeGraph()
  if (mutation === "settings") {
    Object.assign(graph.nodes[1].data.details, {
      supacrmCheckout: {
        ...graph.nodes[1].data.details.supacrmCheckout,
        amountRUB: 1,
      },
    })
  }
  if (mutation === "ports") {
    graph.nodes[1].data.details.quickReplies.pop()
  }
  if (mutation === "core") {
    Reflect.deleteProperty(graph.nodes[1], "position")
  }
  if (mutation === "edge core") {
    Reflect.deleteProperty(graph.edges[0], "sourceHandle")
  }
  if (mutation === "fulfillment ports") {
    graph.nodes[5].data.details.quickReplies.pop()
  }
  if (mutation === "product") {
    Object.assign(graph.nodes[0].data.details, {
      supacrmProduct: {
        ...graph.nodes[0].data.details.supacrmProduct,
        price: 1,
      },
    })
  }
  if (mutation === "fulfillment") {
    Object.assign(graph.nodes[5].data.details, {
      supacrmFulfillment: {
        ...graph.nodes[5].data.details.supacrmFulfillment,
        strategy: "untrusted",
      },
    })
  }
  const result = await post({ graph })
  expect(result.status).toBe(422)
  expect(result.body.code).toBe("invalidRequestData")
  expect(write).not.toHaveBeenCalled()
})

test.each([
  "spec",
  "nodes",
  "edges",
])("native envelope rejects mixed %s input", async (field) => {
  expect(
    (
      await post({
        graph: nativeGraph(),
        [field]: field === "spec" ? legacy.spec : [],
      })
    ).status,
  ).toBe(422)
})

test("legacy spec keeps compiled graph response and token workspace context", async () => {
  const result = await post(legacy)
  expect(result.status).toBe(200)
  expect(result.body.nodes).toHaveLength(1)
  expect(result.body.nodes[0].type).toBe("sendMessage")
  expect(result.body.nodes[0].data.details.steps[0].text).toBe("Hello")
  expect(result.body.edges).toEqual([])
  expect(authoringContext).toHaveBeenCalledWith("ws-1")
  expect(write).not.toHaveBeenCalled()
})

test("native and legacy requests require automation scope", async () => {
  findWorkspaceByTokenHash.mockResolvedValue(authResult(["contacts"]))
  for (const body of [{ graph: nativeGraph() }, legacy]) {
    expect((await post(body)).status).toBe(403)
  }
  expect(authoringContext).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

test("native validation requires a workspace bearer token", async () => {
  expect((await post({ graph: nativeGraph() }, false)).status).toBe(401)
})
