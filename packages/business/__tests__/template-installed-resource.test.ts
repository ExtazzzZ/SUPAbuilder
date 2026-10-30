// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest"

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    query: { templateInstalledResourceModel: { findMany: mockFindMany } },
  },
}))

const { templateResourceKinds } = await import("@chatbotx.io/database/partials")
const { TEMPLATE_LOCKED_CONTENT_KEYS } = await import(
  "../src/template/lock-policy"
)
const {
  assertDeletable,
  assertEditable,
  assertResourceEditable,
  listLockedIds,
} = await import("../src/template/installed-resource.service")

/** A fresh transaction stand-in per call: the lock set is remembered per handle. */
const stubTx = () =>
  ({
    execute: vi.fn(),
    query: { templateInstalledResourceModel: { findMany: mockFindMany } },
  }) as never

const base = {
  workspaceId: "ws-1",
  resourceKind: "flow",
  resourceIds: ["f1", "f2"],
}

describe("assertEditable takes the per-resource locks", () => {
  const makeTx = (live: Record<string, string[]>) => ({
    execute: vi.fn(),
    query: {
      templateInstalledResourceModel: {
        findMany: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            await Promise.resolve()
            if ("allowEdit" in where) {
              return []
            }
            const kind = String(where.resourceKind)
            return (live[kind] ?? []).map((resourceId) => ({ resourceId }))
          },
        ),
      },
    },
  })

  test("a write on a resource with no live provenance row takes no lock", async () => {
    const tx = makeTx({})

    await assertEditable({
      ...base,
      resourceIds: ["f1"],
      changedKeys: ["nodes"],
      lockedContentKeys: ["nodes"],
      tx: tx as never,
    })

    expect(tx.execute).not.toHaveBeenCalled()
  })

  test("a toggle never takes a lock, even on an installed resource", async () => {
    const tx = makeTx({ flow: ["f1"] })

    await assertEditable({
      ...base,
      resourceIds: ["f1"],
      changedKeys: ["active"],
      lockedContentKeys: ["nodes"],
      tx: tx as never,
    })

    expect(tx.execute).not.toHaveBeenCalled()
    expect(
      tx.query.templateInstalledResourceModel.findMany,
    ).not.toHaveBeenCalled()
  })

  test("a content write locks the resource and its installed parents in one pass", async () => {
    const tx = makeTx({ reflink: ["r1"], flow: ["f9"] })

    await assertEditable({
      ...base,
      resourceKind: "reflink",
      resourceIds: ["r1"],
      changedKeys: ["flowId"],
      lockedContentKeys: ["flowId"],
      referencedParents: [
        { kind: "flow", resourceId: "f9" },
        { kind: "flow", resourceId: "not-installed" },
      ],
      tx: tx as never,
    })

    // flow:f9 sorts before reflink:r1; the uninstalled parent is not locked.
    expect(tx.execute).toHaveBeenCalledTimes(2)
  })
})

describe("changedKeysOf", () => {
  test("an unchanged full-form save changes nothing", async () => {
    const { changedKeysOf } = await import(
      "../src/template/installed-resource.service"
    )
    const stored = { name: "A", flowId: "f1", branding: { logo: 1, size: 2 } }

    expect(
      changedKeysOf(stored, {
        name: "A",
        flowId: "f1",
        branding: { size: 2, logo: 1 },
      }),
    ).toEqual([])
  })

  test("reports only the keys whose value differs, and ignores undefined", async () => {
    const { changedKeysOf } = await import(
      "../src/template/installed-resource.service"
    )

    expect(
      changedKeysOf(
        { name: "A", flowId: "f1", text: "x" },
        { name: "B", flowId: "f1", text: undefined },
      ),
    ).toEqual(["name"])
  })
})

describe("template installed-resource guards", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe("assertDeletable", () => {
    test("does nothing for an empty id list, without querying", async () => {
      await assertDeletable({ ...base, resourceIds: [] })

      expect(mockFindMany).not.toHaveBeenCalled()
    })

    test("passes when no installed copy locks deletion", async () => {
      mockFindMany.mockResolvedValue([])

      await expect(assertDeletable(base)).resolves.toBeUndefined()
    })

    test("throws when one id is governed by a copy that disallows deletion", async () => {
      mockFindMany.mockResolvedValue([{ resourceId: "f2" }])

      await expect(assertDeletable(base)).rejects.toMatchObject({
        code: "templateAllowDeleteViolation",
      })
    })

    test("asks one query for the whole id set, scoped to active copies of another's making", async () => {
      mockFindMany.mockResolvedValue([])

      await assertDeletable(base)

      expect(mockFindMany).toHaveBeenCalledTimes(1)
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: "ws-1",
            resourceKind: "flow",
            resourceId: { in: ["f1", "f2"] },
            wasExisting: false,
            detachedAt: { isNull: true },
            allowDelete: false,
            installation: {
              sourceDeletedAt: { isNull: true },
              templateId: { isNotNull: true },
            },
          }),
        }),
      )
    })
  })

  describe("assertEditable", () => {
    test("a write touching no content key never queries", async () => {
      await assertEditable({
        ...base,
        changedKeys: ["active", "folderId"],
        lockedContentKeys: ["name", "nodes"],
        tx: stubTx(),
      })

      expect(mockFindMany).not.toHaveBeenCalled()
    })

    test("a content write against a locked copy is a 403", async () => {
      mockFindMany.mockResolvedValue([{ resourceId: "f1" }])

      await expect(
        assertEditable({
          ...base,
          changedKeys: ["nodes"],
          lockedContentKeys: ["name", "nodes"],
          tx: stubTx(),
        }),
      ).rejects.toMatchObject({
        code: "templateAllowEditViolation",
        httpStatusCode: 403,
      })
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ allowEdit: false }),
        }),
      )
    })

    test("a content write passes when nothing locks it", async () => {
      mockFindMany.mockResolvedValue([])

      await expect(
        assertEditable({
          ...base,
          changedKeys: ["name"],
          lockedContentKeys: ["name"],
          tx: stubTx(),
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe("assertResourceEditable", () => {
    test("uses the kind's locked content keys", async () => {
      mockFindMany.mockResolvedValue([{ resourceId: "f1" }])

      await expect(
        assertResourceEditable({
          ...base,
          changedKeys: ["nodes"],
          tx: stubTx(),
        }),
      ).rejects.toMatchObject({ code: "templateAllowEditViolation" })
    })

    test("an installer-owned field of the same kind is never checked", async () => {
      await assertResourceEditable({
        ...base,
        changedKeys: ["active"],
        tx: stubTx(),
      })

      expect(mockFindMany).not.toHaveBeenCalled()
    })

    test("every resource kind has a lock policy entry", () => {
      for (const kind of templateResourceKinds.options) {
        expect(TEMPLATE_LOCKED_CONTENT_KEYS[kind]).toBeDefined()
      }
    })
  })

  describe("listLockedIds", () => {
    test("returns the locked ids of a list page in one query", async () => {
      mockFindMany.mockResolvedValue([{ resourceId: "f2" }])

      await expect(listLockedIds(base)).resolves.toEqual(["f2"])
      expect(mockFindMany).toHaveBeenCalledTimes(1)
    })
  })
})
