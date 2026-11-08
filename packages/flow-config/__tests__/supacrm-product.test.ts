import { describe, expect, it } from "vitest"
import { remapReferences } from "../src/import-export/remap"
import {
  getSupacrmProduct,
  publishFlowSchema,
  sendMessageNodeDefaultFn,
} from "../src/index"
import {
  createSupacrmProductNode,
  selectSupacrmProduct,
} from "../src/nodes/supacrm-product"

const itemId = "123e4567-e89b-42d3-a456-426614174000"
const COPIED_CATALOG_FIELDS = /price|tariff|apiKey|image/i

describe("Товар CRM как совместимый sendMessage", () => {
  it("создаёт невыбранный блок, который нельзя опубликовать", () => {
    const node = createSupacrmProductNode({ dataProps: { name: "Товар" } })
    expect(node.type).toBe("sendMessage")
    expect(node.data.details.supacrmProduct).toEqual({ catalogItemId: "" })
    expect(
      publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
    ).toBe(false)
  })
  it("сохраняет только ссылку и компилирует действительный API marker", () => {
    const node = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
    const parsed = publishFlowSchema.parse({ nodes: [node], edges: [] })
      .nodes[0]
    expect(parsed).toEqual(node)
    expect(node.data.details.supacrmProduct).toEqual({ catalogItemId: itemId })
    expect(node.data.details.beforeStep.channel).toBe("api")
    expect(node.data.details.steps).toHaveLength(1)
    expect(node.data.details.steps[0]).toMatchObject({
      stepType: "sendText",
      text: `SUPACRM_ACTION_V1:{"action":"catalog.detail","payload":{"item_id":"${itemId}"}}`,
    })
    expect(JSON.stringify(node)).not.toMatch(COPIED_CATALOG_FIELDS)
  })
  it("отвергает расхождение metadata и marker или другой канал", () => {
    const node = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
    const bad = structuredClone(node)
    bad.data.details.steps = [
      { ...node.data.details.steps[0], text: "Другой текст" },
    ] as typeof bad.data.details.steps
    expect(
      publishFlowSchema.safeParse({ nodes: [bad], edges: [] }).success,
    ).toBe(false)
    const wrongChannel = structuredClone(node)
    wrongChannel.data.details.beforeStep.channel = "telegram"
    expect(
      publishFlowSchema.safeParse({ nodes: [wrongChannel], edges: [] }).success,
    ).toBe(false)
  })
  it("оставляет legacy sendMessage без изменений", () => {
    const node = sendMessageNodeDefaultFn({})
    expect(
      publishFlowSchema.parse({ nodes: [node], edges: [] }).nodes[0],
    ).toEqual(node)
  })
  it("remap локальных сущностей не меняет внешнюю ссылку CRM и marker", () => {
    const node = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
    const remapped = remapReferences(node, {
      customField: new Map([[itemId, "999"]]),
      flow: new Map([[itemId, "888"]]),
    })
    expect(remapped.data.details.supacrmProduct?.catalogItemId).toBe(itemId)
    expect(remapped.data.details.steps).toEqual(node.data.details.steps)
  })
})

it("switching the selected product recompiles the marker with a stable step ID", () => {
  const node = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
  const next = selectSupacrmProduct(
    node,
    "123e4567-e89b-42d3-a456-426614174001",
  )
  expect(next.data.details.steps[0].id).toBe(node.data.details.steps[0].id)
  expect(next.data.details.steps[0]).not.toEqual(node.data.details.steps[0])
  expect(getSupacrmProduct(null)).toBeNull()
  expect(
    getSupacrmProduct({ supacrmProduct: { catalogItemId: itemId, price: 20 } }),
  ).toBeNull()
  expect(
    publishFlowSchema.safeParse({ nodes: [next], edges: [] }).success,
  ).toBe(true)
})
