import { describe, expect, it } from "vitest"
import {
  applyReceiptEmailTemplate,
  configureSupacrmCheckout,
  createSupacrmCheckoutNode,
  createSupacrmEmailNode,
  createSupacrmProductNode,
  getReceiptEmailTemplateBase,
  publishFlowSchema,
  selectSupacrmProduct,
  sendMessageNodeSchema,
  supacrmCheckoutSchema,
  withSupacrmTariffSelection,
} from "../src"

describe("native owned checkout", () => {
  it("exposes typed builders without financial authority in the graph", () => {
    expect(createSupacrmCheckoutNode).toBeTypeOf("function")
    for (const kind of ["offer", "receipt", "link", "wait"] as const) {
      const node = createSupacrmCheckoutNode({}, kind)
      expect(sendMessageNodeSchema.safeParse(node).success).toBe(true)
      expect(node.data.details.quickReplies).toHaveLength(
        { offer: 4, receipt: 3, link: 6, wait: 3 }[kind],
      )
      expect(
        supacrmCheckoutSchema.safeParse({
          ...node.data.details.supacrmCheckout,
          paid: true,
        }).success,
      ).toBe(false)
    }
  })
  it("preserves opaque outputs on configuration and rejects marker drift", () => {
    expect(configureSupacrmCheckout).toBeTypeOf("function")
    const node = createSupacrmCheckoutNode({}, "wait")
    const changed = configureSupacrmCheckout(node, {
      ...node.data.details.supacrmCheckout,
      prompt: "Новый текст",
    })
    expect(changed.data.details.quickReplies).toEqual(
      node.data.details.quickReplies,
    )
    changed.data.details.steps[0].text = "paid=true"
    expect(sendMessageNodeSchema.safeParse(changed).success).toBe(false)
  })
})

it("publishes one connected checkout while preserving the adopted Email template", () => {
  const product = withSupacrmTariffSelection(
    selectSupacrmProduct(
      createSupacrmProductNode({}),
      "123e4567-e89b-42d3-a456-426614174000",
    ),
    true,
  )
  const email = createSupacrmEmailNode({})
  const adopted = applyReceiptEmailTemplate(email, {
    source: {
      kind: "receiptEmail",
      flowId: "10",
      flowVersionId: "20",
      nodeId: "30",
    },
    snapshot: email.data.details.supacrmForm,
    overrides: { prompt: "Адрес для чека" },
  })
  const nodes = [
    product,
    createSupacrmCheckoutNode({}, "offer"),
    createSupacrmCheckoutNode({}, "receipt"),
    adopted,
    createSupacrmCheckoutNode({}, "link"),
    createSupacrmCheckoutNode({}, "wait"),
  ]
  const edges = nodes.slice(0, -1).map((node, i) => ({
    id: String(100 + i),
    source: node.id,
    sourceHandle: node.data.details.quickReplies[0].id,
    target: nodes[i + 1].id,
    targetHandle: nodes[i + 1].id,
  }))
  const parsed = publishFlowSchema.parse(
    JSON.parse(JSON.stringify({ nodes, edges })),
  )
  expect(getReceiptEmailTemplateBase(parsed.nodes)).toEqual(
    getReceiptEmailTemplateBase(nodes),
  )
  expect(parsed.nodes[3].data.details).toEqual(adopted.data.details)
  expect(adopted.data.details.quickReplies).toHaveLength(2)
  expect(nodes[5].data.details.quickReplies).toHaveLength(3)
})

it.each(["promo", "bonus", "referral_summary"] as const)("strict benefit %s preserves identity and rejects authority", (kind) => {
  const node = createSupacrmCheckoutNode({}, kind)
  expect(sendMessageNodeSchema.safeParse(node).success).toBe(true)
  const changed = configureSupacrmCheckout(node, { ...node.data.details.supacrmCheckout, prompt: "Новый вопрос" })
  expect(changed.id).toBe(node.id)
  expect(changed.data.details.quickReplies).toEqual(node.data.details.quickReplies)
  expect(changed.data.details.steps[0].id).toBe(node.data.details.steps[0].id)
  for (const extra of [{ amount: 1 }, { user_id: 2 }, { reward: 15_000 }, { policy: "other" }]) {
    expect(supacrmCheckoutSchema.safeParse({ ...changed.data.details.supacrmCheckout, ...extra }).success).toBe(false)
  }
  changed.data.details.quickReplies.pop()
  expect(sendMessageNodeSchema.safeParse(changed).success).toBe(false)
})
