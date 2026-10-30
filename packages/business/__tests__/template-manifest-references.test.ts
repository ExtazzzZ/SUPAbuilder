// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  collectManifestReferences,
  customFieldNameFromToken,
} from "../src/template/manifest-references"

const flowEntry = (steps: Record<string, unknown>[]) => ({
  sourceId: "flow-1",
  nodes: [{ id: "n1", data: { details: { steps } } }],
  edges: [],
})

describe("collectManifestReferences", () => {
  test("finds a tag a trigger action uses even when no tag was selected (E1)", () => {
    const references = collectManifestReferences([
      {
        sourceId: "trigger-1",
        actions: [{ actionType: "addTag", tagIds: ["678679"] }],
      },
    ])

    expect([...references.tagIds]).toEqual(["678679"])
  })

  test("finds custom fields from id slots and ignores system-field slugs", () => {
    const references = collectManifestReferences([
      flowEntry([
        { id: "s1", stepType: "setCustomField", inputFieldId: "12345" },
        { id: "s2", stepType: "setCustomField", inputFieldId: "first_name" },
      ]),
    ])

    expect([...references.customFieldIds]).toEqual(["12345"])
  })

  test("a third-party tag list is not a tag reference", () => {
    const references = collectManifestReferences([
      flowEntry([
        { id: "s1", stepType: "activeCampaignSyncContact", tagIds: ["1"] },
      ]),
    ])

    expect(references.tagIds.size).toBe(0)
  })

  test("reads tag ids held in a Condition value", () => {
    const references = collectManifestReferences([
      {
        sourceId: "trigger-1",
        conditions: [{ field: "tags", operator: "in", value: ["11", "12"] }],
      },
    ])

    expect([...references.tagIds].sort()).toEqual(["11", "12"])
  })

  test("finds custom-field names used as {{name}} and {{raw:name}} tokens", () => {
    const references = collectManifestReferences([
      flowEntry([
        {
          id: "s1",
          stepType: "sendText",
          text: "Hi {{shoe_size}}, {{raw:Notes}} and {{first_name}}",
        },
      ]),
    ])

    expect([...references.customFieldNames].sort()).toEqual([
      "Notes",
      "shoe_size",
    ])
  })

  test("returns nothing for entries with no references", () => {
    const references = collectManifestReferences([
      { sourceId: "x", name: "plain" },
    ])

    expect(references.tagIds.size).toBe(0)
    expect(references.customFieldIds.size).toBe(0)
    expect(references.customFieldNames.size).toBe(0)
  })
})

describe("customFieldNameFromToken", () => {
  test.each([
    ["shoe_size", "shoe_size"],
    ["  shoe_size  ", "shoe_size"],
    ["raw:Notes", "Notes"],
  ])("%s addresses custom field %s", (token, expected) => {
    expect(customFieldNameFromToken(token)).toBe(expected)
  })

  test.each([
    "first_name",
    "coupon:SUMMER",
    "bot_field:123",
    "pipelines.deals.name",
    "",
  ])("%s is not a custom-field token", (token) => {
    expect(customFieldNameFromToken(token)).toBeNull()
  })
})
