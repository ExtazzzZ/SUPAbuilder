import { describe, expect, it } from "vitest"
import {
  configureSupacrmFulfillment,
  createSupacrmFulfillmentNode,
  parseSupacrmFulfillmentCommand,
  sendMessageNodeSchema,
  supacrmFulfillmentSchema,
} from "../src"

describe("Исполнение и выдача Apple US", () => {
  it("сохраняет идентификаторы и запрещает автору подменять владельца", () => {
    for (const kind of ["execute", "issue"] as const) {
      const node = createSupacrmFulfillmentNode({}, kind)
      expect(sendMessageNodeSchema.safeParse(node).success).toBe(true)
      const updated = configureSupacrmFulfillment(
        node,
        node.data.details.supacrmFulfillment,
      )
      expect(updated).toEqual(node)
      expect(updated.data.details.quickReplies).toHaveLength(3)
      expect(
        supacrmFulfillmentSchema.safeParse({
          ...node.data.details.supacrmFulfillment,
          orderId: "secret",
        }).success,
      ).toBe(false)
      node.data.details.steps[0].text += "changed"
      expect(sendMessageNodeSchema.safeParse(node).success).toBe(false)
    }
  })
  it("фиксирует две обязательные части в порядке инструкции и кода", () => {
    const node = createSupacrmFulfillmentNode({}, "issue")
    const settings = node.data.details.supacrmFulfillment
    if (settings?.kind !== "issue") {
      throw new Error("Expected issue block")
    }
    expect(settings.plan.requiredParts.map((p) => p.key)).toEqual([
      "author_instruction",
      "apple_code_reference",
    ])
    expect(
      supacrmFulfillmentSchema.safeParse({
        ...settings,
        plan: {
          ...settings.plan,
          requiredParts: [...settings.plan.requiredParts].reverse(),
        },
      }).success,
    ).toBe(false)
    for (const text of [
      "{{code}}",
      "\ud800",
      "x\u0001x",
      '"'.repeat(2000),
      "😀".repeat(1001),
    ]) {
      const parts = [
        { ...settings.plan.requiredParts[0], text },
        settings.plan.requiredParts[1],
      ]
      expect(
        supacrmFulfillmentSchema.safeParse({
          ...settings,
          plan: { ...settings.plan, requiredParts: parts },
        }).success,
        JSON.stringify(text.slice(0, 10)),
      ).toBe(false)
    }
    expect(
      parseSupacrmFulfillmentCommand(node.data.details.steps[0].text),
    ).toEqual(settings)
    expect(
      parseSupacrmFulfillmentCommand('SUPACRM_ACTION_V1:{"action":"other"}'),
    ).toBeNull()
  })
})
