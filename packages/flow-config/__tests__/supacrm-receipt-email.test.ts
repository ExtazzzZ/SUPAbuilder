import { expect, it } from "vitest"
import {
  applyRouteUpdatesInNodes,
  configureSupacrmEmail,
  createSupacrmEmailNode,
  createSupacrmProductNode,
  publishFlowSchema,
  selectSupacrmProduct,
  sendTextStepDefaultFn,
  supacrmFormSchema,
  withSupacrmTariffSelection,
} from "../src/index"

const itemId = "123e4567-e89b-42d3-a456-426614174000"

it("accepts the routes authored by the normal canvas without losing form settings", () => {
  const email = createSupacrmEmailNode({})
  const product = withSupacrmTariffSelection(
    selectSupacrmProduct(createSupacrmProductNode({}), itemId),
    true,
  )
  const routed = applyRouteUpdatesInNodes(
    [product, email],
    [
      {
        sourceNodeId: product.id,
        handleId: product.data.details.quickReplies[0].id,
        route: { targetNodeId: email.id },
      },
    ],
  )
  expect(
    publishFlowSchema.parse({
      nodes: routed,
      edges: [
        {
          id: "100",
          source: product.id,
          sourceHandle: product.data.details.quickReplies[0].id,
          target: email.id,
          targetHandle: email.id,
        },
      ],
    }).nodes,
  ).toHaveLength(2)
})

it("executes an opt-in tariff choice while preserving default Product and editor sections", () => {
  const ordinary = selectSupacrmProduct(createSupacrmProductNode({}), itemId)
  ordinary.data.editorMetadata = {
    section: { id: "catalog", title: "Каталог" },
  }
  expect(withSupacrmTariffSelection).toBeTypeOf("function")
  const node = withSupacrmTariffSelection(ordinary, true)
  expect(node.data.details.quickReplies).toHaveLength(2)
  expect(node.data.details.steps[0]).toMatchObject({
    text: expect.stringContaining('"action":"catalog.select_tariff"'),
  })
  const next = selectSupacrmProduct(
    node,
    "123e4567-e89b-42d3-a456-426614174001",
  )
  expect(next.data.details.quickReplies.map((b) => b.id)).toEqual(
    node.data.details.quickReplies.map((b) => b.id),
  )
  expect(next.data.editorMetadata).toEqual(ordinary.data.editorMetadata)
  expect(
    publishFlowSchema.safeParse({ nodes: [next], edges: [] }).success,
  ).toBe(true)
  const legacy = withSupacrmTariffSelection(next, false)
  expect(legacy.data.details.quickReplies).toEqual([])
  expect(legacy.data.details.supacrmProduct).toEqual({
    catalogItemId: "123e4567-e89b-42d3-a456-426614174001",
  })
})

it("saves a native receipt-email form with stable outputs and matching executable settings", () => {
  expect(createSupacrmEmailNode).toBeTypeOf("function")
  const node = createSupacrmEmailNode({})
  const settings = {
    ...supacrmFormSchema.parse(node.data.details.supacrmForm),
    prompt: "Напишите почту",
    invalidMessage: "Проверьте адрес",
  }
  const changed = configureSupacrmEmail(node, settings)
  expect(changed.data.details.quickReplies.map((b) => b.id)).toEqual(
    node.data.details.quickReplies.map((b) => b.id),
  )
  expect(changed.data.details.steps[0]).toMatchObject({
    text: expect.stringContaining('"prompt":"Напишите почту"'),
  })
  const reloaded = publishFlowSchema.parse(
    JSON.parse(JSON.stringify({ nodes: [changed], edges: [] })),
  )
  expect(reloaded.nodes[0]).toEqual(changed)
  changed.data.details.steps[0] = sendTextStepDefaultFn({
    text: "not a form",
  })
  expect(
    publishFlowSchema.safeParse({ nodes: [changed], edges: [] }).success,
  ).toBe(false)
})

it("does not admit executable validators or extra financial form settings", () => {
  expect(createSupacrmEmailNode).toBeTypeOf("function")
  const node = createSupacrmEmailNode({})
  expect(() =>
    configureSupacrmEmail(node, {
      ...node.data.details.supacrmForm,
      validator: "javascript",
    }),
  ).toThrow()
  expect(() =>
    configureSupacrmEmail(node, {
      ...node.data.details.supacrmForm,
      price: 100,
    }),
  ).toThrow()
})
