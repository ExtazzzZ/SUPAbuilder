import { describe, expect, test } from "vitest"
import { buildSupacrmMigrationDraft } from "../src/migration/supacrm-draft"
import { collectFlowReferenceWarnings, parseFlowExport, remapCustomFieldReferences } from "../src"
import { writeFileSync } from "node:fs"

describe("Черновик переноса SUPAcrm", () => {
  test("Нативная схема, API-канал и закрытая активация", () => {
    const draft = buildSupacrmMigrationDraft()
    const parsed = parseFlowExport(draft)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
    const flow = parsed.data.flows[0]
    expect(flow.active).toBe(false)
    expect(flow.enableInInbox).toBe(false)
    expect(flow.nodes.every(node => node.type === "sendMessage" && node.data.details.beforeStep.channel === "api")).toBe(true)
    expect(flow.nodes.filter(node => node.data.isStartNode).map(node => node.id)).toEqual([flow.startNodeId])
    expect(collectFlowReferenceWarnings(flow)).toEqual([])
    expect(remapCustomFieldReferences(flow, new Map())).toEqual(flow)
    const ids = new Set(flow.nodes.map(node => node.id))
    for (const edge of flow.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
      expect(edge.targetHandle).toBe(edge.target)
    }
    const content = JSON.stringify(draft)
    expect(content).not.toMatch(/serviceKey|Authorization|callApi|Session JSON|https?:/)
    expect(content).toContain("catalog.search_prompt")
    expect(content).toContain("operator.handoff")
    if (process.env.CATALOG_DRAFT_OUTPUT) writeFileSync(process.env.CATALOG_DRAFT_OUTPUT, JSON.stringify(draft, null, 2))
  })
})
