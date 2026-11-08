import { z } from "zod"

/** T1 safe browser authoring DTO 1.0.0; literal_slot не является runtime vault capability. */
export const SOURCE_LOGIC_DTO_VERSION = "1.0.0"
export const sourceUnaryOperatorsV1 = ["+", "-", "not", "!", "~"] as const
export const sourceBinaryOperatorsV1 = [
  "+",
  "-",
  "*",
  "/",
  "//",
  "%",
  "**",
  "==",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "in",
  "and",
  "or",
  "&&",
  "||",
  "|",
] as const
export const sourceLiteralTypesV1 = [
  "str",
  "num",
  "list",
  "dict",
  "bool",
  "attachment",
  "expr",
  "date",
  "datetime",
  "null",
] as const
export type SourceTypedExprV1 =
  | { kind: "symbol"; symbol_id: string }
  | {
      kind: "literal_slot"
      slot_id: string
      declared_type: (typeof sourceLiteralTypesV1)[number]
    }
  | { kind: "local"; parameter_id: string }
  | {
      kind: "unary"
      operator: (typeof sourceUnaryOperatorsV1)[number]
      operand: SourceTypedExprV1
    }
  | {
      kind: "binary"
      operator: (typeof sourceBinaryOperatorsV1)[number]
      left: SourceTypedExprV1
      right: SourceTypedExprV1
    }
  | { kind: "call"; function_id: string; arguments: SourceTypedExprV1[] }
  | {
      kind: "conditional"
      condition: SourceTypedExprV1
      when_true: SourceTypedExprV1
      when_false: SourceTypedExprV1
    }
  | { kind: "list" | "tuple"; items: SourceTypedExprV1[] }
  | {
      kind: "dict"
      entries: { key: SourceTypedExprV1; value: SourceTypedExprV1 }[]
    }
  | { kind: "index"; collection: SourceTypedExprV1; index: SourceTypedExprV1 }
  | {
      kind: "lambda"
      parameters: { kind: "local"; parameter_id: string }[]
      body: SourceTypedExprV1
    }

const identifier = z.string().min(1)
const localIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const localExpr = z.strictObject({
  kind: z.literal("local"),
  parameter_id: localIdentifier,
})

/** Строгая рекурсивная схема всех AST форм замороженного JSON schema T1. */
export const sourceTypedExprV1Schema: z.ZodType<SourceTypedExprV1> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("symbol"), symbol_id: identifier }),
      z.strictObject({
        kind: z.literal("literal_slot"),
        slot_id: identifier,
        declared_type: z.enum(sourceLiteralTypesV1),
      }),
      localExpr,
      z.strictObject({
        kind: z.literal("unary"),
        operator: z.enum(sourceUnaryOperatorsV1),
        operand: sourceTypedExprV1Schema,
      }),
      z.strictObject({
        kind: z.literal("binary"),
        operator: z.enum(sourceBinaryOperatorsV1),
        left: sourceTypedExprV1Schema,
        right: sourceTypedExprV1Schema,
      }),
      z.strictObject({
        kind: z.literal("call"),
        function_id: localIdentifier,
        arguments: z.array(sourceTypedExprV1Schema),
      }),
      z.strictObject({
        kind: z.literal("conditional"),
        condition: sourceTypedExprV1Schema,
        when_true: sourceTypedExprV1Schema,
        when_false: sourceTypedExprV1Schema,
      }),
      z.strictObject({
        kind: z.enum(["list", "tuple"]),
        items: z.array(sourceTypedExprV1Schema),
      }),
      z.strictObject({
        kind: z.literal("dict"),
        entries: z.array(
          z.strictObject({
            key: sourceTypedExprV1Schema,
            value: sourceTypedExprV1Schema,
          }),
        ),
      }),
      z.strictObject({
        kind: z.literal("index"),
        collection: sourceTypedExprV1Schema,
        index: sourceTypedExprV1Schema,
      }),
      z.strictObject({
        kind: z.literal("lambda"),
        parameters: z.array(localExpr),
        body: sourceTypedExprV1Schema,
      }),
    ]),
)

export const sourceSpanV1Schema = z
  .strictObject({
    scenario_id: z.string(),
    block_id: z.string(),
    path: z.string(),
    start: z.number().int().nonnegative().default(0),
    end: z.number().int().nonnegative().default(0),
    sequence: z.number().int().nonnegative().default(0),
  })
  .refine((span) => span.end >= span.start)
export const sourcePortV1Schema = z.strictObject({
  scenario_id: z.string(),
  block_id: z.string(),
  source_path: z.string(),
  name: z.string().nullable(),
  target_block_id: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
})
export const sourceDiagnosticV1Schema = z.strictObject({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]).default("error"),
  span: sourceSpanV1Schema,
  related_ids: z.array(z.string()).default([]),
})
const editTarget = {
  expected_source_hash: z.string().regex(/^[0-9a-f]{64}$/),
  target: sourceSpanV1Schema,
}
export const sourceLogicalEditV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...editTarget,
    kind: z.literal("guard"),
    expression: sourceTypedExprV1Schema,
  }),
  z.strictObject({
    ...editTarget,
    kind: z.literal("assignment"),
    symbol_id: identifier,
    mode: z.enum(["set", "+", "-"]).default("set"),
    operands: z.array(sourceTypedExprV1Schema).min(1).max(2),
  }),
  z.strictObject({
    ...editTarget,
    kind: z.literal("transition"),
    port: sourcePortV1Schema,
    target_block_id: z.string().nullable(),
  }),
])
export type SourceLogicalEditV1 = z.infer<typeof sourceLogicalEditV1Schema>
export const sourceLogicProjectionV1Schema = z.strictObject({
  dto_version: z.literal("1.0.0").default("1.0.0"),
  source_hash: z.string(),
  edits: z.array(sourceLogicalEditV1Schema),
  diagnostics: z.array(sourceDiagnosticV1Schema),
  publishable: z.literal(false).default(false),
})
export type SourceLogicProjectionV1 = z.infer<
  typeof sourceLogicProjectionV1Schema
>

/** Лимит editor transport проверяется до рекурсивного parse, без вычисления AST. */
export function parseSourceLogicProjectionV1(
  input: unknown,
): SourceLogicProjectionV1 {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [
    { value: input, depth: 0 },
  ]
  let visited = 0
  const seen = new Set<object>()
  while (stack.length) {
    const item = stack.pop()
    if (!item) {
      break
    }
    if (item.exit) {
      seen.delete(item.value as object)
      continue
    }
    visited++
    if (item.depth > 256 || visited > 1_000_000) {
      throw new Error("Лимит сложности авторского выражения")
    }
    if (item.value && typeof item.value === "object") {
      if (seen.has(item.value)) {
        throw new Error("Циклическое авторское выражение")
      }
      seen.add(item.value)
      stack.push({ value: item.value, depth: item.depth, exit: true })
      for (const value of Object.values(item.value)) {
        stack.push({ value, depth: item.depth + 1 })
      }
    }
  }
  return sourceLogicProjectionV1Schema.parse(input)
}

/** Собирает только безопасные handles параметров; значения не читаются и не создаются. */
export function collectSourceLiteralSlotsV1(logic: SourceLogicProjectionV1) {
  const slots = new Map<
    string,
    Extract<SourceTypedExprV1, { kind: "literal_slot" }>
  >()
  const visit = (expr: SourceTypedExprV1) => {
    if (expr.kind === "literal_slot") {
      slots.set(JSON.stringify([expr.slot_id, expr.declared_type]), expr)
    }
    for (const value of Object.values(expr)) {
      if (value && typeof value === "object") {
        const children = Array.isArray(value) ? value : [value]
        for (const child of children) {
          if (child && typeof child === "object" && "kind" in child) {
            visit(child as SourceTypedExprV1)
          } else if (
            child &&
            typeof child === "object" &&
            "key" in child &&
            "value" in child
          ) {
            visit(child.key as SourceTypedExprV1)
            visit(child.value as SourceTypedExprV1)
          }
        }
      }
    }
  }
  for (const edit of logic.edits) {
    if (edit.kind === "guard") {
      visit(edit.expression)
    }
    if (edit.kind === "assignment") {
      for (const operand of edit.operands) {
        visit(operand)
      }
    }
  }
  return [...slots.values()]
}
