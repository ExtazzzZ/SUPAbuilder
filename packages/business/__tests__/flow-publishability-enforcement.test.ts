// @vitest-environment node

import {
  createSupacrmCheckoutNode,
  sendMessageNodeDefaultFn,
  sendVideoStepDefaultFn,
} from "@chatbotx.io/flow-config"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  dbTransaction: vi.fn(),
  ensureFolderExists: vi.fn(),
  insert: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    insert: mocks.insert,
    query: { flowModel: { findFirst: vi.fn() } },
    transaction: mocks.dbTransaction,
    update: vi.fn(),
  },
  eq: vi.fn(),
  inArray: vi.fn(),
}))

vi.mock("@chatbotx.io/database/partials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/database/partials")>()),
  rootFolderId: "0",
}))
vi.mock("../src/messenger-welcome-message-flow/service", () => ({
  messengerWelcomeMessageFlowService: { enqueueSync: vi.fn() },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  flowRepository: { listIdsByIds: vi.fn(), listPublishedOptions: vi.fn() },
  whatsappMessageTemplateRepository: { listIdsByIntegration: vi.fn() },
}))
vi.mock("@chatbotx.io/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/database/schema")>()),
  flowAnalyticsSessionModel: {},
  flowModel: {},
  flowVersionModel: {},
}))
vi.mock("../src/base.service", () => ({
  BaseService: class BaseService {
    audit = vi.fn()
  },
}))
vi.mock("../src/bot-field/service", () => ({
  botFieldService: { resolveByNameAndType: vi.fn() },
}))
vi.mock("../src/custom-field/service", () => ({
  customFieldService: { resolveByNameAndType: vi.fn() },
}))
vi.mock("../src/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/errors")>()),
  notFoundException: (message: string) => new Error(message),
}))
vi.mock("../src/folder/service", () => ({
  folderService: { ensureExists: mocks.ensureFolderExists },
}))
vi.mock("../src/template/installed-resource.service", () => ({
  assertDeletable: vi.fn(),
}))
// flow-version/service imports these for quick reply cleanup on publish.
vi.mock("../src/conversation/service", () => ({ conversationService: {} }))
vi.mock("../src/smart-delay/service", () => ({ smartDelayService: {} }))
vi.mock("../src/flow-version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/flow-version")>()),
  flowVersionService: { findDraft: vi.fn(), invalidateList: vi.fn() },
}))

const { flowService } = await import("../src/flow/service")

const incompatibleGraph = () => {
  const node = sendMessageNodeDefaultFn({})
  node.data.details.beforeStep.channel = "tiktok"
  node.data.details.steps = [sendVideoStepDefaultFn()]

  return { edges: [], nodes: [node], startNodeId: node.id }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("flow publishability enforcement", () => {
  test("rejects createPublished before folder and database side effects", async () => {
    await expect(
      flowService.createPublished({
        workspaceId: "workspace-1",
        data: { folderId: "folder-1", name: "Unsupported" },
        graph: incompatibleGraph(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "The tiktok channel does not support sendVideo.",
      ),
      name: "FlowAuthoringException",
    })

    expect(mocks.ensureFolderExists).not.toHaveBeenCalled()
    expect(mocks.dbTransaction).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  test("rejects createFromImport before database side effects", () => {
    const graph = incompatibleGraph()

    expect(() =>
      flowService.createFromImport({
        workspaceId: "workspace-1",
        name: "Unsupported",
        active: true,
        enableInInbox: true,
        ...graph,
      }),
    ).toThrow("The tiktok channel does not support sendVideo.")

    expect(mocks.dbTransaction).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})

const invalidWrapperGraph = () => {
  const node = createSupacrmCheckoutNode({}, "bonus")
  node.data.details.supacrmCheckout = {
    ...node.data.details.supacrmCheckout,
    amountRUB: 100_000,
  } as typeof node.data.details.supacrmCheckout
  return { nodes: [node], edges: [], startNodeId: node.id }
}
test("createDraft rejects typed extras before folder or database mutation", async () => {
  await expect(
    flowService.createDraft({
      workspaceId: "1",
      data: { name: "bad", folderId: "2" },
      graph: invalidWrapperGraph(),
    }),
  ).rejects.toThrow()
  expect(mocks.dbTransaction).not.toHaveBeenCalled()
  expect(mocks.ensureFolderExists).not.toHaveBeenCalled()
})
test("draft import rejects typed extras even without publish validation", () => {
  expect(() =>
    flowService.createFromImport({
      workspaceId: "1",
      name: "bad",
      active: false,
      enableInInbox: false,
      validatePublishable: false,
      ...invalidWrapperGraph(),
    }),
  ).toThrow()
  expect(mocks.dbTransaction).not.toHaveBeenCalled()
})
test("import export rejects typed extras before manifest/database mutation", async () => {
  await expect(
    flowService.importFlowExport({
      workspaceId: "1",
      name: "bad",
      active: false,
      enableInInbox: false,
      customFields: {},
      botFields: {},
      ...invalidWrapperGraph(),
    }),
  ).rejects.toThrow()
  expect(mocks.dbTransaction).not.toHaveBeenCalled()
})
test("template published-default owner rejects typed extras before first insert", async () => {
  await expect(
    flowService.createPublishedDefault({ insert: mocks.insert } as never, {
      workspaceId: "1",
      name: "bad",
      ...invalidWrapperGraph(),
    }),
  ).rejects.toThrow()
  expect(mocks.insert).not.toHaveBeenCalled()
})
