import type {
  receiptEmailTemplateChangeResultSchema,
  receiptEmailTemplateChangeSchema,
} from "@chatbotx.io/business"
import {
  getReceiptEmailTemplateBase,
  receiptEmailContentKey,
} from "@chatbotx.io/flow-config"
import type { z } from "zod"

export type ReceiptEmailTemplateDraftRequest = Omit<
  z.infer<typeof receiptEmailTemplateChangeSchema>,
  "flowId" | "expectedNode" | "expectedGraph"
>
export type ReceiptEmailTemplateDraftResult = z.infer<
  typeof receiptEmailTemplateChangeResultSchema
>

export function createReceiptEmailTemplateAcknowledgement(
  nodes: readonly unknown[],
) {
  let base = structuredClone(getReceiptEmailTemplateBase(nodes))
  return {
    getBase: () => structuredClone(base),
    acknowledge: (savedNodes: readonly unknown[]) => {
      base = structuredClone(getReceiptEmailTemplateBase(savedNodes))
    },
  }
}

export function createReceiptEmailTemplateDraftMutation(deps: {
  isMutatingRef: { current: boolean }
  setMutating: (busy: boolean) => void
  cancelAutosave: () => void
  waitForSaves: () => Promise<void>
  getGraph: () => {
    nodes: { id: string; [key: string]: unknown }[]
    edges: unknown[]
  }
  mutate: (
    input: ReceiptEmailTemplateDraftRequest & {
      expectedNode: Record<string, unknown>
      expectedGraph: { nodes: unknown[]; edges: unknown[] }
    },
  ) => Promise<ReceiptEmailTemplateDraftResult>
  apply: (
    node: Extract<ReceiptEmailTemplateDraftResult, { status: "ready" }>["node"],
  ) => void
}) {
  const previews = new Map<
    string,
    { graph: ReturnType<typeof deps.getGraph>; intent: string }
  >()
  return async (request: ReceiptEmailTemplateDraftRequest) => {
    if (deps.isMutatingRef.current) {
      throw new Error("receiptEmailTemplateBusy")
    }
    deps.isMutatingRef.current = true
    deps.setMutating(true)
    deps.cancelAutosave()
    try {
      await deps.waitForSaves()
      const graph = deps.getGraph()
      const intent = receiptEmailContentKey({
        source: request.source,
        overrides: request.overrides,
      })
      const preview = previews.get(request.nodeId)
      if (
        request.action === "adopt" &&
        preview &&
        (preview.intent !== intent ||
          receiptEmailContentKey(preview.graph) !==
            receiptEmailContentKey(graph))
      ) {
        throw new Error("receiptEmailTemplateStalePreview")
      }
      const expectedNode = graph.nodes.find(
        (node) => node.id === request.nodeId,
      )
      if (!expectedNode) {
        throw new Error("receiptEmailTemplateNodeMissing")
      }
      const result = await deps.mutate({
        ...request,
        expectedNode,
        expectedGraph: graph,
      })
      if (request.action === "preview" && result.status === "ready") {
        previews.set(request.nodeId, { graph, intent })
      }
      if (request.action !== "preview" && result.status === "ready") {
        deps.apply(result.node)
      }
      return result
    } finally {
      deps.isMutatingRef.current = false
      deps.setMutating(false)
    }
  }
}
