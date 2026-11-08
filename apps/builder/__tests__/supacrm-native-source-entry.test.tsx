// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"
import FlowPage from "../src/app/(no-sidebar)/space/[workspaceId]/flows/[id]/page"

const ports = vi.hoisted(() => ({
  permission: vi.fn(),
  find: vi.fn(),
  binding: vi.fn(),
  integrations: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  flowService: { findById: ports.find },
}))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found")
  },
}))
vi.mock("../src/features/flows/flow-detail", () => ({ FlowDetail: () => null }))
vi.mock("../src/features/integration-openai-compatible/queries", () => ({
  listIntegrationOpenaiCompatible: ports.integrations,
}))
vi.mock("../src/lib/auth/require-workspace-permission", () => ({
  requireWorkspacePermission: ports.permission,
}))
vi.mock("../src/lib/source-authoring-native/server", () => ({
  resolveNativeSourceDocument: ports.binding,
}))
const source = {
  kind: "source",
  bindingId: "binding",
  workspaceId: "100",
  flowId: "200",
  registryId: "11111111-1111-4111-8111-111111111111",
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
}
const flow = {
  id: "200",
  workspaceId: "100",
  name: "Source flow",
  active: true,
  enableInInbox: true,
  currentVersionId: null,
  draftVersionId: null,
  folderId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  flowVersions: [
    {
      id: "300",
      isDraft: true,
      isLatest: false,
      nodes: [{ data: { text: "PRIVATE_LEGACY_VALUE" } }],
      edges: [],
    },
  ],
}
beforeEach(() => {
  vi.clearAllMocks()
  ports.permission.mockResolvedValue(undefined)
  ports.find.mockResolvedValue(flow)
  ports.binding.mockResolvedValue(source)
  ports.integrations.mockResolvedValue([])
})
const open = async () => {
  const page = await FlowPage({
    params: Promise.resolve({ workspaceId: "100", id: "200" }),
  })
  return page.props.children
}

test("source native route does not send legacy FlowVersion or private graph into client props", async () => {
  const page = await open()
  expect(ports.binding).toHaveBeenCalledWith({
    workspaceId: "100",
    flowId: "200",
  })
  expect(page.props.sourceBinding).toEqual(source)
  expect(page.props.flowVersion).toBeUndefined()
  expect(page.props.flow.flowVersions).toBeUndefined()
  expect(JSON.stringify(page.props)).not.toContain("PRIVATE_LEGACY_VALUE")
  expect(ports.integrations).not.toHaveBeenCalled()
})
test("source route does not require a fabricated native draft FlowVersion", async () => {
  ports.find.mockResolvedValue({ ...flow, flowVersions: [] })
  const page = await open()
  expect(page.props.sourceBinding.bindingId).toBe("binding")
})
test("blocked source lookup never falls back to legacy graph even when draft exists", async () => {
  ports.binding.mockResolvedValue({
    kind: "blocked",
    code: "source_binding_unavailable",
  })
  await expect(open()).rejects.toThrow("not_found")
  expect(ports.integrations).not.toHaveBeenCalled()
})
test("known legacy document still uses normal native draft and integrations", async () => {
  ports.binding.mockResolvedValue({ kind: "legacy" })
  const page = await open()
  expect(page.props.flowVersion.id).toBe("300")
  expect(ports.integrations).toHaveBeenCalledWith({ workspaceId: "100" })
  expect(page.props.sourceBinding).toBeUndefined()
})
