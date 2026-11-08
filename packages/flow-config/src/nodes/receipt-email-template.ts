import {
  effectiveReceiptEmailSettings,
  receiptEmailTemplateSchema,
} from "../extensions/receipt-email-template"
import type { SendMessageNodeSchema } from "./send-message"
import { configureSupacrmEmail } from "./supacrm-form"

export function applyReceiptEmailTemplate(
  node: SendMessageNodeSchema,
  input: unknown,
): SendMessageNodeSchema {
  const template = receiptEmailTemplateSchema.parse(input)
  const updated = configureSupacrmEmail(
    node,
    effectiveReceiptEmailSettings(template),
  )
  return {
    ...updated,
    data: {
      ...updated.data,
      details: { ...updated.data.details, supacrmFormTemplate: template },
    },
  }
}

export function detachReceiptEmailTemplate(
  node: SendMessageNodeSchema,
): SendMessageNodeSchema {
  const { supacrmFormTemplate: _template, ...details } = node.data.details
  return { ...node, data: { ...node.data, details } }
}

/** Only foreign imports/installations detach; same-workspace pins stay atomic. */
export function detachImportedReceiptEmailTemplates<
  T extends { nodes: unknown[] },
>(
  graph: T,
): T & {
  warnings: { entityKind: string; path: string; value: string }[]
} {
  const warnings: { entityKind: string; path: string; value: string }[] = []
  const nodes = graph.nodes.map((node, index) => {
    const candidate = node as SendMessageNodeSchema
    const template = candidate?.data?.details?.supacrmFormTemplate
    if (!template) {
      return node
    }
    warnings.push({
      entityKind: "receiptEmailTemplateDetached",
      path: `nodes[${index}].data.details.supacrmFormTemplate`,
      value: template.source.flowVersionId,
    })
    return detachReceiptEmailTemplate(candidate)
  })
  return { ...graph, nodes, warnings }
}
