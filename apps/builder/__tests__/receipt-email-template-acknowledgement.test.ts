import {
  applyReceiptEmailTemplate,
  createSupacrmEmailNode,
  getReceiptEmailTemplateBase,
  getSupacrmForm,
} from "@chatbotx.io/flow-config"
import { expect, test } from "vitest"

test("acknowledges the exact saved payload, never a newer unsaved graph, and advances on explicit adoption/undo ACK", async () => {
  const module = await import(
    "../src/features/flows/supacrm-form/template-draft"
  )
  expect(module).toHaveProperty("createReceiptEmailTemplateAcknowledgement")
  const node = createSupacrmEmailNode({ nodeProps: { id: "101" } })
  const source = {
    kind: "receiptEmail",
    flowId: "10",
    flowVersionId: "20",
    nodeId: "30",
  } as const
  const r1 = applyReceiptEmailTemplate(node, {
    source,
    snapshot: getSupacrmForm(node.data.details),
    overrides: {},
  })
  const r2 = applyReceiptEmailTemplate(node, {
    source: { ...source, flowVersionId: "21" },
    snapshot: getSupacrmForm(node.data.details),
    overrides: {},
  })
  const ack = module.createReceiptEmailTemplateAcknowledgement([r1])
  const requestBase = ack.getBase()
  const pendingSavedPayload = structuredClone([r1])
  ack.acknowledge(pendingSavedPayload)
  expect(ack.getBase()).toEqual(getReceiptEmailTemplateBase([r1]))
  expect(ack.getBase()).not.toEqual(getReceiptEmailTemplateBase([r2]))
  ack.acknowledge([r2])
  expect(requestBase).toEqual(getReceiptEmailTemplateBase([r1]))
  expect(ack.getBase()).toEqual(getReceiptEmailTemplateBase([r2]))
  ack.acknowledge([node])
  expect(ack.getBase()).toEqual([])
})
