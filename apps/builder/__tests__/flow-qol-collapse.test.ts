import { expect, test } from "vitest"
import { buildCollapsedSectionView } from "@/features/flows/react-flow/qol/section-view"

const nodes = [
  {
    id: "101",
    position: { x: 100, y: 200 },
    data: {
      name: "A",
      editorMetadata: { section: { id: "s", title: "Каталог" } },
    },
  },
  {
    id: "102",
    position: { x: 400, y: 200 },
    data: {
      name: "B",
      editorMetadata: { section: { id: "s", title: "Каталог" } },
    },
  },
  { id: "103", position: { x: 700, y: 200 }, data: { name: "C" } },
]
const edges = [
  { id: "internal", source: "101", target: "102" },
  { id: "first", source: "101", target: "103", sourceHandle: "same-name-a" },
  { id: "second", source: "102", target: "103", sourceHandle: "same-name-b" },
  { id: "incoming", source: "103", target: "101", targetHandle: "input" },
]

test("collapses only presentation, retains every boundary identity and assigns distinct port coordinates", () => {
  const before = JSON.stringify({ nodes, edges })
  const view = buildCollapsedSectionView(nodes, edges, ["s"])
  expect([...view.hiddenNodeIds]).toEqual(["101", "102"])
  expect([...view.hiddenEdgeIds]).toEqual(["internal"])
  expect(view.sections[0]?.ports.map((port) => port.edgeId)).toEqual([
    "first",
    "second",
    "incoming",
  ])
  expect(view.sections[0]?.ports.map((port) => port.label)).toEqual([
    "A → C",
    "B → C",
    "C → A",
  ])
  expect(view.edgePositions.get("first")?.sourceY).not.toEqual(
    view.edgePositions.get("second")?.sourceY,
  )
  expect(view.edgePositions.get("incoming")?.targetX).toBe(100)
  expect(JSON.stringify({ nodes, edges })).toBe(before)
  expect(buildCollapsedSectionView(nodes, edges, []).hiddenNodeIds.size).toBe(0)
})
