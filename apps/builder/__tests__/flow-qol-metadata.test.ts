import {
  assignFlowSection,
  flowExportedFlowSchema,
  publishFlowSchema,
  queryFlowGraph,
  removeFlowSection,
  sendMessageNodeDefaultFn,
} from "@chatbotx.io/flow-config"
import { describe, expect, test } from "vitest"
import { serializeFlowContent } from "@/features/flows/flow-version-content"
import { createFlowHistoryStore } from "@/features/flows/react-flow/stores/flow-history-store"

const makeNodes = () => [
  sendMessageNodeDefaultFn({
    nodeProps: { id: "101" },
    dataProps: { name: "Каталог", isStartNode: true },
  }),
  sendMessageNodeDefaultFn({
    nodeProps: { id: "102" },
    dataProps: { name: "Товар" },
  }),
]

describe("editor section persistence", () => {
  test("membership survives draft serialization, publish/export parsing and undo/redo without runtime changes", () => {
    const original = makeNodes()
    const grouped = assignFlowSection(original, {
      id: "catalog",
      title: "Каталог",
      nodeIds: ["101", "102"],
    })
    expect(grouped.map((n) => n.data.details)).toEqual(
      original.map((n) => n.data.details),
    )
    expect(queryFlowGraph({ nodes: grouped, edges: [] }).sections).toEqual([
      { id: "catalog", title: "Каталог", nodeIds: ["101", "102"] },
    ])
    const reloaded = JSON.parse(serializeFlowContent(grouped, []))
    const parsed = flowExportedFlowSchema.parse({
      name: "Demo",
      active: false,
      enableInInbox: false,
      startNodeId: "101",
      ...reloaded,
    })
    expect(queryFlowGraph(parsed).sections).toHaveLength(1)
    expect(
      publishFlowSchema.parse({ nodes: grouped, edges: [] }).nodes[0]?.data
        .editorMetadata?.section?.title,
    ).toBe("Каталог")
    const history = createFlowHistoryStore().getState()
    history.takeSnapshot(original, [])
    expect(history.undo({ nodes: grouped, edges: [] })?.nodes).toEqual(original)
    expect(history.redo({ nodes: original, edges: [] })?.nodes).toEqual(grouped)
    expect(removeFlowSection(grouped, "catalog")).toEqual(original)
  })
  test("renames all members atomically and moves a member between sections", () => {
    const first = assignFlowSection(makeNodes(), {
      id: "one",
      title: "Первый",
      nodeIds: ["101", "102"],
    })
    const renamed = assignFlowSection(first, {
      id: "one",
      title: "Новое имя",
      nodeIds: ["101"],
    })
    expect(renamed[1]?.data.editorMetadata?.section?.title).toBe("Новое имя")
    const moved = assignFlowSection(renamed, {
      id: "two",
      title: "Второй",
      nodeIds: ["102"],
    })
    expect(queryFlowGraph({ nodes: moved, edges: [] }).sections).toEqual([
      { id: "one", title: "Новое имя", nodeIds: ["101"] },
      { id: "two", title: "Второй", nodeIds: ["102"] },
    ])
    expect(() =>
      assignFlowSection(moved, {
        id: "empty",
        title: "",
        nodeIds: ["101"],
      }),
    ).toThrow()
    expect(() =>
      assignFlowSection(moved, { id: "x", title: "x", nodeIds: [] }),
    ).toThrow()
  })
  test("rejects conflicting section titles explicitly while old graphs remain valid", () => {
    const old = makeNodes()
    expect(
      flowExportedFlowSchema.parse({
        name: "Old",
        active: false,
        enableInInbox: false,
        startNodeId: "101",
        nodes: old,
        edges: [],
      }).nodes,
    ).toHaveLength(2)
    const conflict = old.map((n, i) => ({
      ...n,
      data: {
        ...n.data,
        editorMetadata: { section: { id: "same", title: String(i) } },
      },
    }))
    expect(
      publishFlowSchema.safeParse({ nodes: conflict, edges: [] }).success,
    ).toBe(false)
    expect(() => queryFlowGraph({ nodes: conflict, edges: [] })).toThrow(
      "Conflicting section titles",
    )
  })
})
