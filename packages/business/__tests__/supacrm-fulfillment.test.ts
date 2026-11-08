import { createSupacrmFulfillmentNode } from "@chatbotx.io/flow-config"
import { afterEach, expect, it, vi } from "vitest"

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock("../src/flow", () => ({ flowService: { findById: vi.fn() } }))
vi.mock("../src/flow-version", () => ({ flowVersionService: { findById } }))
vi.mock("../src/net/ssrf-guard", () => ({
  checkSsrfSafety: vi.fn(async () => ({ unsafe: false })),
}))

import {
  fulfillmentStatusService,
  supacrmFulfillmentService,
} from "../src/supacrm-fulfillment"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
const origin = {
  workspaceId: "10",
  inboxId: "20",
  flowId: "30",
  flowVersionId: "40",
  nodeId: "50",
  stepId: "90",
  contactId: "70",
  conversationId: "80",
}
function setup() {
  const node = createSupacrmFulfillmentNode(
    { nodeProps: { id: "50" } },
    "execute",
  )
  node.data.details.steps[0].id = "90"
  const outputs = node.data.details.quickReplies.map(
    (port) => `30:40:${port.id}:::100`,
  )
  const version = {
    id: "40",
    flowId: "30",
    workspaceId: "10",
    isDraft: false,
    isLatest: false,
    nodes: [node],
    edges: [
      {
        source: "50",
        sourceHandle: node.data.details.quickReplies[0].id,
        target: "60",
      },
    ],
  }
  findById.mockResolvedValue(version)
  const ref = "123e4567-e89b-42d3-a456-426614174000"
  const registry = "123e4567-e89b-42d3-a456-426614174001"
  const response = {
    status: {
      fulfillmentRef: ref,
      purchaseStatus: "completed",
      deliveryStatus: "pending",
      nativeStatus: "completed",
      parts: [],
    },
    origin,
    registryId: registry,
    peerId: "42",
    blockId: "block",
    terminalEventId: "fulfillment-wait:schedule",
    outputs,
  }
  vi.stubEnv(
    "SUPACRM_FULFILLMENT_API_URL",
    "https://crm.example/api/v1/automation/native-fulfillment/status",
  )
  vi.stubEnv("SUPACRM_FULFILLMENT_API_KEY", "synthetic")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response)),
  )
  return {
    node,
    version,
    response,
    input: {
      ...origin,
      fulfillmentRef: ref,
      blockId: "block",
      terminalEventId: response.terminalEventId,
      sourceEventId: response.terminalEventId,
      action: outputs[0],
      sourceId: `supacrm:${registry}:42`,
    },
  }
}
it("происхождение требует опубликованный узел, точный marker и все output IDs", async () => {
  const { node } = setup()
  const input = {
    ...origin,
    marker: node.data.details.steps[0].text,
    portIds: node.data.details.quickReplies.map((p) => p.id),
  }
  expect(await supacrmFulfillmentService.origin(input)).toEqual(origin)
  await expect(
    supacrmFulfillmentService.origin({ ...input, marker: "forged" }),
  ).rejects.toThrow("fulfillment_origin_invalid")
  await expect(
    supacrmFulfillmentService.origin({ ...input, portIds: [] }),
  ).rejects.toThrow("fulfillment_origin_invalid")
})
it("continuation выбирает v1 без latest fallback после v2 publish", async () => {
  const { version, input } = setup()
  expect(await fulfillmentStatusService.continuation(input)).toEqual(version)
  expect(findById).toHaveBeenCalledWith({
    workspaceId: "10",
    flowId: "30",
    versionId: "40",
  })
  for (const changed of [
    { sourceEventId: "other" },
    { workspaceId: "foreign" },
    { inboxId: "other" },
    { contactId: "other" },
    { conversationId: "other" },
    { sourceId: "other" },
    { flowVersionId: "41" },
    { blockId: "other" },
    { action: "forged" },
  ]) {
    await expect(
      fulfillmentStatusService.continuation({ ...input, ...changed }),
    ).rejects.toThrow()
  }
})
it("missing/draft published lookup сохраняет реальные owner статусы и review", async () => {
  const { input } = setup()
  findById.mockRejectedValue(new Error("missing published version"))
  await expect(fulfillmentStatusService.continuation(input)).rejects.toThrow()
  expect(await fulfillmentStatusService.read(input)).toMatchObject({
    purchaseStatus: "completed",
    deliveryStatus: "pending",
    nativeStatus: "review",
    errorCode: "fulfillment_pinned_version_unavailable",
  })
})

it("status read denies foreign workspace/flow/ref and fetches only no-store safe DTO", async () => {
  const { input, response } = setup()
  expect(await fulfillmentStatusService.read(input)).toEqual(response.status)
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ cache: "no-store", redirect: "error" }),
  )
  for (const changed of [
    { workspaceId: "999" },
    { flowId: "999" },
    { fulfillmentRef: "123e4567-e89b-42d3-a456-426614174999" },
  ]) {
    await expect(
      fulfillmentStatusService.read({ ...input, ...changed }),
    ).rejects.toThrow("fulfillment_status_scope_invalid")
  }
  expect(
    JSON.stringify(await fulfillmentStatusService.read(input)),
  ).not.toContain("registryId")
})
