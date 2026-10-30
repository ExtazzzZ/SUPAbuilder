// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  tagFindMany: vi.fn(),
  customFieldFindMany: vi.fn(),
  folderFindFirst: vi.fn(),
  listCategories: vi.fn(),
  findPipeline: vi.fn(),
  listInboxes: vi.fn(),
  snapshot: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    query: {
      tagModel: { findMany: mocks.tagFindMany },
      customFieldModel: { findMany: mocks.customFieldFindMany },
      folderModel: { findFirst: mocks.folderFindFirst },
    },
  },
}))
vi.mock("@chatbotx.io/database/partials", () => ({ rootFolderId: "0" }))
vi.mock("@chatbotx.io/database/repositories", () => ({
  inboxRepository: { listIdentitiesByIds: mocks.listInboxes },
  pipelineRepository: { findByReferenceName: mocks.findPipeline },
  productCategoryRepository: { list: mocks.listCategories },
}))
vi.mock("../src/template/snapshot.service", () => ({
  buildTemplateSnapshot: mocks.snapshot,
}))
vi.mock("../src/template/adapters/registry", () => ({
  templateAdapterRegistry: { flows: {}, sequences: {}, settings: {} },
}))

const { previewInstallCollisions, previewDependencies } = await import(
  "../src/template/install-preview"
)
const { predictAction, MANIFEST_COLLISION_POLICY } = await import(
  "../src/template/collision-policy"
)

const emptyManifests = {
  folders: {},
  customFields: {},
  tags: {},
  productCategories: {},
  pipelines: {},
  inboxes: {},
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tagFindMany.mockResolvedValue([])
  mocks.customFieldFindMany.mockResolvedValue([])
  mocks.listCategories.mockResolvedValue([])
  mocks.listInboxes.mockResolvedValue([])
  mocks.folderFindFirst.mockResolvedValue(null)
})

describe("predictAction", () => {
  test.each([
    ["tags", { found: true }, "reuse"],
    ["tags", { found: false }, "create"],
    ["customFields", { found: true }, "reuse"],
    ["customFields", { found: false, sameNameOtherType: true }, "rename"],
    ["customFields", { found: false }, "create"],
    ["inboxes", { found: true, bindable: true }, "bind"],
    ["inboxes", { found: true, bindable: false }, "unbound"],
  ] as const)("%s %j -> %s", (kind, match, expected) => {
    expect(predictAction(kind, match)).toBe(expected)
  })

  test("the policy table names a strategy for every manifest", () => {
    expect(Object.keys(MANIFEST_COLLISION_POLICY).sort()).toEqual([
      "customFields",
      "folders",
      "inboxes",
      "pipelines",
      "productCategories",
      "tags",
    ])
  })
})

describe("previewInstallCollisions", () => {
  test("predicts reuse, create and rename per manifest in one pass", async () => {
    mocks.tagFindMany.mockResolvedValue([{ id: "t9", name: "vip" }])
    mocks.customFieldFindMany.mockResolvedValue([
      { id: "c1", name: "Age", type: "number" },
    ])
    mocks.findPipeline.mockResolvedValue({ id: "p9" })

    const { collisions, summary } = await previewInstallCollisions({
      workspaceId: "ws-1",
      manifests: {
        ...emptyManifests,
        tags: { a: { name: "vip" }, b: { name: "new" } },
        customFields: {
          f1: { name: "age", type: "number" },
          f2: { name: "Age", type: "text" },
          f3: { name: "City", type: "text" },
        },
        pipelines: { p1: { name: "Sales", referenceName: "sales" } },
      } as never,
    })

    // The lookup must not filter by exact names: the match folds case.
    expect(mocks.customFieldFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } }),
    )

    const actionOf = (manifest: string, sourceId: string) =>
      collisions.find((c) => c.manifest === manifest && c.sourceId === sourceId)
        ?.action
    expect(actionOf("tags", "a")).toBe("reuse")
    expect(actionOf("tags", "b")).toBe("create")
    expect(actionOf("customFields", "f1")).toBe("reuse")
    expect(actionOf("customFields", "f2")).toBe("rename")
    expect(actionOf("customFields", "f3")).toBe("create")
    expect(actionOf("pipelines", "p1")).toBe("reuse")
    expect(summary).toMatchObject({ reuse: 3, create: 2, rename: 1 })
  })

  test("a folder under a folder that will be created is created too, without a lookup", async () => {
    const { collisions } = await previewInstallCollisions({
      workspaceId: "ws-1",
      manifests: {
        ...emptyManifests,
        folders: {
          f1: { name: "A", folderType: "flow", parentSourceId: null },
          f2: { name: "B", folderType: "flow", parentSourceId: "f1" },
        },
      } as never,
    })

    expect(collisions.map((c) => c.action)).toEqual(["create", "create"])
    expect(mocks.folderFindFirst).toHaveBeenCalledTimes(1)
  })

  test("an install folder makes every top-level folder new", async () => {
    mocks.folderFindFirst.mockResolvedValue({ id: "existing" })

    const { collisions } = await previewInstallCollisions({
      workspaceId: "ws-1",
      createInstallFolder: true,
      manifests: {
        ...emptyManifests,
        folders: {
          f1: { name: "A", folderType: "flow", parentSourceId: null },
        },
      } as never,
    })

    expect(collisions[0].action).toBe("create")
  })

  test("an inbox is bound only when connected and on the same channel", async () => {
    mocks.listInboxes.mockResolvedValue([
      { id: "i1", channel: "messenger", status: "connected", name: "x" },
      { id: "i2", channel: "whatsapp", status: "connected", name: "y" },
    ])

    const { collisions } = await previewInstallCollisions({
      workspaceId: "ws-1",
      manifests: {
        ...emptyManifests,
        inboxes: {
          i1: { channelType: "messenger", name: "Page" },
          i2: { channelType: "messenger", name: "Other" },
          i3: { channelType: "messenger", name: "Gone" },
        },
      } as never,
    })

    expect(collisions.map((c) => [c.sourceId, c.action])).toEqual([
      ["i1", "bind"],
      ["i2", "unbound"],
      ["i3", "unbound"],
    ])
  })
})

describe("previewDependencies", () => {
  test("lists rows the snapshot added beyond the explicit ids, and the manifests it ships", async () => {
    mocks.snapshot.mockResolvedValue({
      droppedReferenceCount: 3,
      payload: {
        resources: {
          flows: [{ sourceId: "f1" }],
          sequences: [{ sourceId: "s1" }, { sourceId: "s2" }],
          settings: { savedReplies: [], botFields: [] },
        },
        manifests: {
          ...emptyManifests,
          tags: { t: { name: "vip" } },
        },
      },
    })

    const result = await previewDependencies({
      workspaceId: "ws-1",
      tenantId: "1",
      selection: {
        flows: { mode: "ids", ids: ["f1"] },
        sequences: { mode: "ids", ids: ["s1"] },
      } as never,
    })

    expect(result.includedDependencies).toEqual([
      { category: "sequences", sourceId: "s2" },
    ])
    expect(result.manifests).toEqual([
      { kind: "tags", count: 1, names: ["vip"] },
    ])
    expect(result.droppedReferenceCount).toBe(3)
  })

  test("a category selected as all adds nothing", async () => {
    mocks.snapshot.mockResolvedValue({
      payload: {
        resources: {
          flows: [{ sourceId: "f1" }],
          sequences: [],
          settings: { savedReplies: [], botFields: [] },
        },
        manifests: emptyManifests,
      },
    })

    const result = await previewDependencies({
      workspaceId: "ws-1",
      tenantId: "1",
      selection: { flows: { mode: "all" } } as never,
    })

    expect(result.includedDependencies).toEqual([])
  })
})
