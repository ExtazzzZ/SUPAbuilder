import { z } from "zod"

export const flowSectionIdentitySchema = z.object({
  id: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(255),
})

/** Optional editor-only membership; the node and its runtime actions stay intact. */
export const flowEditorMetadataSchema = z.object({
  section: flowSectionIdentitySchema.optional(),
})

export type FlowSection = z.infer<typeof flowSectionIdentitySchema> & {
  nodeIds: string[]
}

export type FlowNavigationNode = {
  id: string
  type?: string
  data?: {
    name?: unknown
    details?: unknown
    editorMetadata?: unknown
  }
}

export type FlowNavigationEdge = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export const getFlowNodeSection = (node: FlowNavigationNode) => {
  const result = flowEditorMetadataSchema.safeParse(node.data?.editorMetadata)
  return result.success ? result.data.section : undefined
}

export function assignFlowSection<T extends FlowNavigationNode>(
  nodes: readonly T[],
  section: FlowSection,
): T[] {
  const identity = flowSectionIdentitySchema.parse(section)
  const ids = new Set(section.nodeIds)
  if (
    !ids.size ||
    section.nodeIds.some((id) => !nodes.some((node) => node.id === id))
  ) {
    throw new Error("A section requires existing member nodes")
  }
  return nodes.map((node) =>
    ids.has(node.id) || getFlowNodeSection(node)?.id === identity.id
      ? {
          ...node,
          data: { ...node.data, editorMetadata: { section: identity } },
        }
      : node,
  )
}

export function removeFlowSection<T extends FlowNavigationNode>(
  nodes: readonly T[],
  sectionId: string,
): T[] {
  return nodes.map((node) => {
    if (getFlowNodeSection(node)?.id !== sectionId || !node.data) {
      return node
    }
    const { editorMetadata: _metadata, ...data } = node.data
    return { ...node, data }
  })
}

export function refineFlowEditorSections(
  nodes: readonly unknown[],
  ctx: z.RefinementCtx,
): void {
  const titles = new Map<string, string>()
  nodes.forEach((value, index) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("data" in value) ||
      !value.data ||
      typeof value.data !== "object" ||
      !("editorMetadata" in value.data)
    ) {
      return
    }
    const parsed = flowEditorMetadataSchema.safeParse(value.data.editorMetadata)
    const section = parsed.success ? parsed.data.section : undefined
    if (
      !parsed.success ||
      (section &&
        titles.has(section.id) &&
        titles.get(section.id) !== section.title)
    ) {
      ctx.addIssue({
        code: "custom",
        path: [index, "data", "editorMetadata"],
        message: "Invalid editor section or conflicting section titles",
      })
    }
    if (section) {
      titles.set(section.id, section.title)
    }
  })
}

export const flowNavigationResultSchema = z.object({
  data: z.array(
    z.object({
      nodeId: z.string(),
      label: z.string(),
      type: z.string(),
      sectionId: z.string().optional(),
    }),
  ),
  sections: z.array(
    flowSectionIdentitySchema.extend({ nodeIds: z.array(z.string()) }),
  ),
  connections: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      sourceHandle: z.string().nullable().optional(),
      targetHandle: z.string().nullable().optional(),
    }),
  ),
})

/** Whitelisted identities only: never walk arbitrary details, headers or credentials. */
export function queryFlowGraph({
  nodes,
  edges,
  query = "",
}: {
  nodes: readonly FlowNavigationNode[]
  edges: readonly FlowNavigationEdge[]
  query?: string
}): z.infer<typeof flowNavigationResultSchema> {
  const sections = new Map<string, FlowSection>()
  const needle = query.trim().normalize("NFKC").toLowerCase()
  const data = nodes.flatMap((node) => {
    const section = getFlowNodeSection(node)
    if (section) {
      const existing = sections.get(section.id)
      if (existing && existing.title !== section.title) {
        throw new Error(`Conflicting section titles: ${section.id}`)
      }
      sections.set(section.id, {
        ...section,
        nodeIds: [...(existing?.nodeIds ?? []), node.id],
      })
    }
    const label = typeof node.data?.name === "string" ? node.data.name : node.id
    const type = node.type ?? ""
    const details = node.data?.details
    const product =
      details && typeof details === "object" && "supacrmProduct" in details
        ? details.supacrmProduct
        : null
    const productId =
      product &&
      typeof product === "object" &&
      "catalogItemId" in product &&
      typeof product.catalogItemId === "string"
        ? product.catalogItemId
        : ""
    const text = [
      node.id,
      label,
      type,
      productId,
      productId ? "product товар" : "",
    ]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase()
    return text.includes(needle)
      ? [
          {
            nodeId: node.id,
            label,
            type,
            ...(section ? { sectionId: section.id } : {}),
          },
        ]
      : []
  })
  return {
    data,
    sections: [...sections.values()],
    connections: edges.map(
      ({ id, source, target, sourceHandle, targetHandle }) => ({
        id,
        source,
        target,
        sourceHandle,
        targetHandle,
      }),
    ),
  }
}
