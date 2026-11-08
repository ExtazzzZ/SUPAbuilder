import { describe, expect, test } from "vitest"
import {
  applyReceiptEmailTemplate,
  configureSupacrmEmail,
  createSupacrmEmailNode,
  detachImportedReceiptEmailTemplates,
  detachReceiptEmailTemplate,
  getSupacrmForm,
  receiptEmailTemplateSchema,
  sendMessageNodeSchema,
  supacrmFormSchema,
} from "../src/index"

const config = {
  createSupacrmEmailNode,
  getSupacrmForm,
  applyReceiptEmailTemplate,
  sendMessageNodeSchema,
  receiptEmailTemplateSchema,
  configureSupacrmEmail,
  detachReceiptEmailTemplate,
  detachImportedReceiptEmailTemplates,
}

const source = {
  kind: "receiptEmail",
  flowId: "10",
  flowVersionId: "20",
  nodeId: "30",
} as const
const email = () =>
  config.createSupacrmEmailNode({
    nodeProps: { id: "101" },
    dataProps: {
      isStartNode: true,
      editorMetadata: { section: { id: "email", title: "Почта" } },
    },
  })

describe("receiptEmail pinned settings", () => {
  test("one source revision updates two consumers retaining local prompts and technical identities", () => {
    expect(config).toHaveProperty("applyReceiptEmailTemplate")
    const a = email(),
      b = email()
    const snapshot = supacrmFormSchema.parse(
      config.getSupacrmForm(a.data.details),
    )
    const apply = config.applyReceiptEmailTemplate
    const first = apply(a, {
      source,
      snapshot,
      overrides: { prompt: "Для товара A" },
    })
    const second = apply(b, {
      source,
      snapshot,
      overrides: { prompt: "Для товара B" },
    })
    const published = structuredClone(first)
    const r2 = {
      source: { ...source, flowVersionId: "21" },
      snapshot: { ...snapshot, invalidMessage: "Общий новый текст" },
    }
    for (const [consumer, prompt] of [
      [first, "Для товара A"],
      [second, "Для товара B"],
    ] as const) {
      const updated = apply(consumer, {
        ...r2,
        overrides: consumer.data.details.supacrmFormTemplate?.overrides ?? {},
      })
      expect(updated.data.details.supacrmForm).toMatchObject({
        prompt,
        invalidMessage: "Общий новый текст",
      })
      expect(updated.id).toBe(consumer.id)
      expect(updated.data.editorMetadata).toEqual(consumer.data.editorMetadata)
      expect(updated.data.details.quickReplies).toEqual(
        consumer.data.details.quickReplies,
      )
      expect(updated.data.details.steps[0].id).toBe(
        consumer.data.details.steps[0].id,
      )
      expect(config.sendMessageNodeSchema.safeParse(updated).success).toBe(true)
    }
    expect(
      published.data.details.supacrmFormTemplate?.source.flowVersionId,
    ).toBe("20")
  })
  test("rejects arbitrary overrides and snapshot/effective mismatch at publish schema", () => {
    expect(config).toHaveProperty("receiptEmailTemplateSchema")
    const node = email(),
      snapshot = supacrmFormSchema.parse(
        config.getSupacrmForm(node.data.details),
      )
    expect(
      config.receiptEmailTemplateSchema.safeParse({
        source,
        snapshot,
        overrides: { validator: "other" },
      }).success,
    ).toBe(false)
    expect(
      config.receiptEmailTemplateSchema.safeParse({
        source,
        snapshot,
        overrides: { prompt: "" },
      }).success,
    ).toBe(false)
    const bound = config.applyReceiptEmailTemplate(node, {
      source,
      snapshot,
      overrides: {},
    })
    const changed = config.configureSupacrmEmail(bound, {
      ...snapshot,
      invalidMessage: "Подмена",
    })
    expect(config.sendMessageNodeSchema.safeParse(changed).success).toBe(false)
  })
  test("detach keeps effective settings and marker without source lookup", () => {
    expect(config).toHaveProperty("detachReceiptEmailTemplate")
    const node = email(),
      snapshot = supacrmFormSchema.parse(
        config.getSupacrmForm(node.data.details),
      )
    const bound = config.applyReceiptEmailTemplate(node, {
      source,
      snapshot,
      overrides: { prompt: "Локальный вопрос" },
    })
    const detached = config.detachReceiptEmailTemplate(bound)
    expect(detached.data.details.supacrmFormTemplate).toBeUndefined()
    expect(detached.data.details.supacrmForm).toEqual(
      bound.data.details.supacrmForm,
    )
    expect(detached.data.details.steps).toEqual(bound.data.details.steps)
    expect(config.sendMessageNodeSchema.safeParse(bound).success).toBe(true)
  })
  test("import detaches a pin before generic remap and preserves effective settings/IDs", () => {
    expect(config).toHaveProperty("detachImportedReceiptEmailTemplates")
    const node = email(),
      snapshot = supacrmFormSchema.parse(
        config.getSupacrmForm(node.data.details),
      )
    const bound = config.applyReceiptEmailTemplate(node, {
      source,
      snapshot,
      overrides: {},
    })
    const graph = { nodes: [bound], edges: [] }
    const imported = config.detachImportedReceiptEmailTemplates(graph)
    expect(imported.warnings).toHaveLength(1)
    expect(imported.nodes[0]).toEqual(config.detachReceiptEmailTemplate(bound))
    expect(bound.data.details.supacrmFormTemplate).toBeDefined()
  })
  test("malformed snapshot yields validation issues rather than throwing from safeParse", () => {
    const node = email(),
      snapshot = supacrmFormSchema.parse(
        config.getSupacrmForm(node.data.details),
      )
    const bound = config.applyReceiptEmailTemplate(node, {
      source,
      snapshot,
      overrides: {},
    })
    const binding = bound.data.details.supacrmFormTemplate
    if (!binding) {
      throw new Error("Missing binding")
    }
    binding.snapshot.prompt = ""
    expect(() => config.sendMessageNodeSchema.safeParse(bound)).not.toThrow()
    expect(config.sendMessageNodeSchema.safeParse(bound).success).toBe(false)
  })
})
