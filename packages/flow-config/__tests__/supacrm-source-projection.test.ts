import { describe, expect, test } from "vitest"
import {
  compileSourceProjection,
  exportSourceProjection,
  sourceKinds,
  sourceProjectionSchema,
} from "../src/source/projection"

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Нет синтетического fixture")
  }
  return value
}

const fixture = () => ({
  version: "supacrm.source-projection.v1",
  sourceRevision: "synthetic-revision",
  nodes: sourceKinds.map((kind, index) => ({
    sourceId: `source-${index}`,
    kind,
    label: `Блок ${kind}`,
    ports: [
      { id: "yes", label: "Да" },
      { id: "no", label: "Нет" },
    ],
    bindings: [{ symbolId: "email", operation: "read" }],
    content: {
      richText: "<b>Синтетический текст</b>",
      buttons: [{ id: "button", label: "Назад", portId: "no" }],
      media: [{ id: "media", kind: "image", assetRef: "asset:synthetic" }],
      editMode: "edit",
    },
    position: { x: index * 50, y: 100 },
  })),
  edges: [
    { id: "edge", sourceId: "source-0", portId: "yes", targetId: "source-1" },
  ],
  symbols: [
    {
      id: "email",
      name: "Почта",
      scope: "user",
      valueType: "str",
      owner: "receipt",
      policy: "read_only",
      operations: ["read"],
    },
  ],
})

describe("Проекция исходного графа", () => {
  test("сохраняет все 32 вида, source IDs, порты, rich text и metadata при round-trip", () => {
    expect(sourceKinds).toHaveLength(32)
    const input = fixture()
    const compiled = compileSourceProjection(input)
    expect(compiled.publishable).toBe(true)
    expect(JSON.parse(exportSourceProjection(compiled.projection))).toEqual(
      input,
    )
  })

  test.each([
    "currentValue",
    "value",
    "credentials",
    "session",
    "customFields",
  ])("отклоняет runtime поле %s вместо молчаливого экспорта", (key) => {
    const input = fixture()
    expect(
      sourceProjectionSchema.safeParse({ ...input, [key]: "synthetic-secret" })
        .success,
    ).toBe(false)
    expect(
      sourceProjectionSchema.safeParse({
        ...input,
        symbols: [{ ...input.symbols[0], [key]: "synthetic-secret" }],
      }).success,
    ).toBe(false)
    expect(() =>
      exportSourceProjection({ ...input, [key]: "synthetic-secret" }),
    ).toThrow()
  })

  test("сохраняет полный metadata registry без квоты 8 ключей", () => {
    const input = fixture()
    input.symbols = Array.from({ length: 1000 }, (_, i) => ({
      ...required(input.symbols[0]),
      id: i === 0 ? "email" : `symbol-${i}`,
    }))
    expect(compileSourceProjection(input).projection.symbols).toHaveLength(1000)
  })

  test("блокирует несуществующие targets и порты без потери source IDs", () => {
    const input = fixture()
    required(input.edges[0]).targetId = "missing"
    required(input.edges[0]).portId = "missing"
    const result = compileSourceProjection(input)
    expect(result.publishable).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["missing_target", "missing_port"]),
    )
    expect(result.projection.edges[0]).toEqual(input.edges[0])
  })

  test("блокирует дублирующиеся IDs и source ports", () => {
    const input = fixture()
    input.nodes.push(required(input.nodes[0]))
    required(input.nodes[1]).ports.push(
      required(required(input.nodes[1]).ports[0]),
    )
    input.symbols.push(required(input.symbols[0]))
    input.edges.push(required(input.edges[0]))
    expect(
      compileSourceProjection(input).diagnostics.map((d) => d.code),
    ).toEqual(
      expect.arrayContaining([
        "duplicate_node",
        "duplicate_port",
        "duplicate_symbol",
        "duplicate_edge",
      ]),
    )
  })

  test("policy native owner запрещает set/reset и secret_ref запрещает чтение в сообщении", () => {
    const input = fixture()
    required(required(input.nodes[0]).bindings[0]).operation = "set"
    expect(
      compileSourceProjection(input).diagnostics.map((d) => d.code),
    ).toContain("operation_denied")
    const secret = {
      ...input.symbols[0],
      policy: "secret_ref",
      operations: ["read"],
    }
    input.symbols = [secret] as typeof input.symbols
    expect(
      compileSourceProjection(input).diagnostics.map((d) => d.code),
    ).toContain("secret_binding")
  })

  test("не разрешает неизвестный symbol или button port", () => {
    const input = fixture()
    required(required(input.nodes[0]).bindings[0]).symbolId = "missing"
    required(required(input.nodes[0]).content.buttons[0]).portId = "missing"
    expect(
      compileSourceProjection(input).diagnostics.map((d) => d.code),
    ).toEqual(expect.arrayContaining(["missing_symbol", "missing_button_port"]))
  })

  test("не принимает произвольные kinds, inline credentials и значения в bindings", () => {
    const input = fixture()
    expect(
      sourceProjectionSchema.safeParse({
        ...input,
        nodes: [{ ...input.nodes[0], kind: "execute_javascript" }],
      }).success,
    ).toBe(false)
    expect(
      sourceProjectionSchema.safeParse({
        ...input,
        nodes: [
          {
            ...input.nodes[0],
            bindings: [
              {
                symbolId: "email",
                operation: "set",
                value: "synthetic-secret",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })
})
