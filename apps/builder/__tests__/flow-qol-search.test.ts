import { queryFlowGraph } from "@chatbotx.io/flow-config"
import { describe, expect, test } from "vitest"

const nodes = [
  {
    id: "101",
    type: "sendMessage",
    data: {
      name: "Каталог Apple",
      details: {
        supacrmProduct: { catalogItemId: "product-public-id" },
        headers: { Authorization: "private-never-index" },
      },
      editorMetadata: { section: { id: "catalog", title: "Каталог" } },
    },
  },
  { id: "102", type: "condition", data: { name: "Проверка почты" } },
]
const edges = [
  {
    id: "a",
    source: "101",
    sourceHandle: "button-a",
    target: "102",
    targetHandle: "102",
  },
  {
    id: "b",
    source: "101",
    sourceHandle: "button-b",
    target: "102",
    targetHandle: "102",
  },
]

describe("flow navigation shared query", () => {
  test.each([
    "КАТАЛОГ",
    "apple",
    "101",
    "sendmessage",
    "product-public-id",
    "product",
  ])("finds allowed node identity for %s", (query) => {
    expect(queryFlowGraph({ nodes, edges, query }).data).toEqual([
      {
        nodeId: "101",
        label: "Каталог Apple",
        type: "sendMessage",
        sectionId: "catalog",
      },
    ])
  })
  test("returns outline and separate handle connections without indexing private fields", () => {
    const result = queryFlowGraph({
      nodes,
      edges,
      query: "private-never-index",
    })
    expect(result.data).toEqual([])
    expect(result.sections).toEqual([
      { id: "catalog", title: "Каталог", nodeIds: ["101"] },
    ])
    expect(result.connections).toEqual(edges)
    expect(queryFlowGraph({ nodes, edges, query: "  " }).data).toHaveLength(2)
  })
})
