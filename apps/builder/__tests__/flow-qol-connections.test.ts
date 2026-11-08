import { describe, expect, test } from "vitest"
import { describeFlowConnection } from "@/features/flows/react-flow/qol/connection-label"
import { buildCollapsedSectionView } from "@/features/flows/react-flow/qol/section-view"

describe("readable connection presentation", () => {
  test("uses known safe button labels and block names while raw identities stay in technical details", () => {
    const nodes = [
      {
        id: "101",
        data: {
          name: "Каталог",
          details: {
            steps: [{ buttons: [{ id: "button-a", label: "Apple" }] }],
            headers: { Authorization: "private-value" },
          },
        },
      },
      { id: "102", data: { name: "Товар" } },
    ]
    const result = describeFlowConnection(nodes, {
      id: "edge-a",
      source: "101",
      sourceHandle: "button-a",
      target: "102",
      targetHandle: "input",
    })
    expect(result.label).toBe("Каталог · Apple → Товар")
    expect(result.technicalDescription).toContain("edge-a")
    expect(result.technicalDescription).toContain("button-a")
    expect(JSON.stringify(result)).not.toContain("private-value")
    expect(
      describeFlowConnection(
        [{ id: "101" }, { id: "102", data: { name: " " } }],
        { id: "e", source: "101", target: "102" },
      ).label,
    ).toBe("101 → 102")
  })
  test("keeps separate boundary ports when names and button labels are identical", () => {
    const nodes = [
      {
        id: "101",
        position: { x: 0, y: 0 },
        data: {
          name: "Каталог",
          editorMetadata: { section: { id: "s", title: "Каталог" } },
          details: {
            quickReplies: [
              { id: "a", label: "Выбрать" },
              { id: "b", label: "Выбрать" },
            ],
          },
        },
      },
      { id: "102", position: { x: 500, y: 0 }, data: { name: "Товар" } },
    ]
    const edges = [
      { id: "first", source: "101", sourceHandle: "a", target: "102" },
      { id: "second", source: "101", sourceHandle: "b", target: "102" },
    ]
    const view = buildCollapsedSectionView(nodes, edges, ["s"])
    expect(view.sections[0]?.ports.map((port) => port.label)).toEqual([
      "Каталог · Выбрать → Товар",
      "Каталог · Выбрать → Товар",
    ])
    expect(view.sections[0]?.ports.map((port) => port.edgeId)).toEqual([
      "first",
      "second",
    ])
    expect(view.edgePositions.get("first")?.sourceY).not.toBe(
      view.edgePositions.get("second")?.sourceY,
    )
  })
})
