import { z } from "zod"

/** Виды source blocks; это редакторская проекция, не второй исполнитель. */
export const sourceKinds = [
  "cancel_event",
  "http_request",
  "send_message",
  "set_vars",
  "set_timer",
  "basic",
  "notify_managers",
  "switch",
  "note",
  "exec_sq",
  "portal_out",
  "read_google_sheets",
  "set_cell_google_sheets",
  "portal_in",
  "user_input",
  "chat_message",
  "ask_gpt",
  "add_row_google_sheets",
  "switch_context",
  "llm_classification",
  "default_answer",
  "webhook",
  "random_choice",
  "communicate_ai",
  "first_message",
  "save_file_attachment",
  "is_group_member",
  "vk_market_item_message",
  "add_to_list",
  "pre_filter_continue",
  "pre_filter",
  "pre_filter_break",
] as const

const identifier = z.string().min(1).max(512)
export const sourceOperationSchema = z.enum(["read", "set", "reset", "command"])
export const sourceSymbolMetadataSchema = z.strictObject({
  id: identifier,
  name: identifier,
  scope: z.enum(["project", "user", "builtin", "run", "block", "loop"]),
  valueType: z.enum([
    "str",
    "num",
    "list",
    "dict",
    "bool",
    "attachment",
    "expr",
    "date",
    "datetime",
  ]),
  owner: identifier,
  policy: z.enum(["read_only", "state", "native_command", "secret_ref"]),
  operations: z.array(sourceOperationSchema),
  declaration: z
    .strictObject({
      rawKey: z.string(),
      definitionRevision: z.string(),
      protected: z.boolean(),
      lifetime: z.enum([
        "declaration",
        "event",
        "run",
        "block",
        "loop",
        "unresolved",
      ]),
      defaultPolicy: z.enum(["missing", "reference", "unresolved"]),
      sensitivity: z.enum(["ordinary", "protected", "secret", "unresolved"]),
      readStrategy: z.enum([
        "state",
        "projection",
        "builtin",
        "local",
        "unresolved",
      ]),
      writeStrategy: z.enum([
        "cas",
        "command",
        "readonly",
        "local",
        "unresolved",
      ]),
      resetPolicy: z.enum(["declaration_default", "context", "unresolved"]),
      units: z.string().nullable(),
    })
    .optional(),
})
export type SourceSymbolMetadata = z.infer<typeof sourceSymbolMetadataSchema>

export const sourceNodeSchema = z.strictObject({
  sourceId: identifier,
  kind: z.enum(sourceKinds),
  label: z.string().max(2000),
  scenarioId: identifier.optional(),
  ports: z.array(
    z.strictObject({
      id: identifier,
      label: z.string().max(2000),
      source: z
        .strictObject({
          scenarioId: z.string(),
          blockId: z.string(),
          path: z.string(),
          name: z.string().nullable(),
          targetBlockId: z.string().nullable(),
          sequence: z.number().int().nonnegative(),
        })
        .optional(),
    }),
  ),
  bindings: z.array(
    z.strictObject({ symbolId: identifier, operation: sourceOperationSchema }),
  ),
  content: z.strictObject({
    richText: z.string().max(100_000).optional(),
    buttons: z
      .array(
        z.strictObject({
          id: identifier,
          label: z.string().max(2000),
          portId: identifier,
        }),
      )
      .optional(),
    media: z
      .array(
        z.strictObject({
          id: identifier,
          kind: z.enum(["image", "video", "audio", "file"]),
          assetRef: identifier,
        }),
      )
      .optional(),
    editMode: z.enum(["send", "edit", "replace"]).optional(),
  }),
  position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
})
export type SourceNode = z.infer<typeof sourceNodeSchema>

export const sourceEdgeSchema = z.strictObject({
  id: identifier,
  sourceId: identifier,
  portId: identifier,
  targetId: identifier,
})
export type SourceEdge = z.infer<typeof sourceEdgeSchema>

/** Только authoring metadata: нет runtime values, secrets, session или custom fields. */
export const sourceProjectionSchema = z.strictObject({
  version: z.literal("supacrm.source-projection.v1"),
  sourceRevision: identifier,
  nodes: z.array(sourceNodeSchema),
  edges: z.array(sourceEdgeSchema),
  symbols: z.array(sourceSymbolMetadataSchema),
  sourceValidation: z
    .strictObject({
      registryComplete: z.boolean(),
      semanticParityVerified: z.boolean(),
      diagnostics: z.array(
        z.strictObject({ code: z.string(), blockId: z.string().optional() }),
      ),
    })
    .optional(),
})
export type SourceProjection = z.infer<typeof sourceProjectionSchema>

export interface SourceDiagnostic {
  code: string
  message: string
  nodeId?: string
  symbolId?: string
}

/** Чистая проверка ссылок; ни один source effect здесь не выполняется. */
export function compileSourceProjection(input: unknown): {
  projection: SourceProjection
  diagnostics: SourceDiagnostic[]
  publishable: boolean
} {
  const projection = sourceProjectionSchema.parse(input)
  const diagnostics: SourceDiagnostic[] = []
  if (projection.sourceValidation) {
    if (!projection.sourceValidation.registryComplete) {
      diagnostics.push({
        code: "registry_incomplete",
        message: "Полный registry исходных определений ещё не подтверждён",
      })
    }
    if (!projection.sourceValidation.semanticParityVerified) {
      diagnostics.push({
        code: "semantic_parity_unverified",
        message: "Совместимость исходной семантики ещё не подтверждена",
      })
    }
    for (const issue of projection.sourceValidation.diagnostics) {
      diagnostics.push({
        code: issue.code,
        ...(issue.blockId ? { nodeId: issue.blockId } : {}),
        message: "Ошибка канонического IR",
      })
    }
  }
  const add = (
    code: string,
    message: string,
    nodeId?: string,
    symbolId?: string,
  ) => {
    diagnostics.push({
      code,
      message,
      ...(nodeId ? { nodeId } : {}),
      ...(symbolId ? { symbolId } : {}),
    })
  }
  const nodes = new Map<string, SourceNode>()
  for (const node of projection.nodes) {
    if (nodes.has(node.sourceId)) {
      add("duplicate_node", "Повтор source ID блока", node.sourceId)
    }
    nodes.set(node.sourceId, node)
  }
  const symbols = new Map<string, SourceSymbolMetadata>()
  for (const symbol of projection.symbols) {
    if (symbols.has(symbol.id)) {
      add("duplicate_symbol", "Повтор ID символа", undefined, symbol.id)
    }
    symbols.set(symbol.id, symbol)
    if (
      symbol.policy === "read_only" &&
      symbol.operations.some((op) => op !== "read")
    ) {
      add(
        "invalid_policy",
        "Read-only символ допускает только чтение",
        undefined,
        symbol.id,
      )
    }
    if (
      symbol.policy === "native_command" &&
      symbol.operations.some((op) => op === "set" || op === "reset")
    ) {
      add(
        "invalid_policy",
        "Native owner изменяется только командой",
        undefined,
        symbol.id,
      )
    }
  }
  for (const node of projection.nodes) {
    const ports = new Set<string>()
    for (const port of node.ports) {
      if (ports.has(port.id)) {
        add("duplicate_port", "Повтор ID порта", node.sourceId)
      }
      ports.add(port.id)
    }
    for (const button of node.content.buttons ?? []) {
      if (!ports.has(button.portId)) {
        add("missing_button_port", "Порт кнопки отсутствует", node.sourceId)
      }
    }
    for (const binding of node.bindings) {
      const symbol = symbols.get(binding.symbolId)
      if (!symbol) {
        add(
          "missing_symbol",
          "Символ отсутствует в metadata registry",
          node.sourceId,
          binding.symbolId,
        )
        continue
      }
      if (symbol.policy === "secret_ref") {
        add(
          "secret_binding",
          "Секрет доступен только серверному owner",
          node.sourceId,
          symbol.id,
        )
      }
      if (
        !symbol.operations.includes(binding.operation) ||
        (symbol.policy === "read_only" && binding.operation !== "read") ||
        (symbol.policy === "native_command" &&
          (binding.operation === "set" || binding.operation === "reset"))
      ) {
        add(
          "operation_denied",
          "Операция запрещена owning policy",
          node.sourceId,
          symbol.id,
        )
      }
    }
  }
  const edgeIds = new Set<string>()
  for (const edge of projection.edges) {
    if (edgeIds.has(edge.id)) {
      add("duplicate_edge", "Повтор ID перехода", edge.sourceId)
    }
    edgeIds.add(edge.id)
    const source = nodes.get(edge.sourceId)
    if (!source) {
      add("missing_source", "Source блока перехода отсутствует", edge.sourceId)
    }
    if (!nodes.has(edge.targetId)) {
      add("missing_target", "Цель перехода отсутствует", edge.sourceId)
    }
    if (source && !source.ports.some((port) => port.id === edge.portId)) {
      add("missing_port", "Source порт перехода отсутствует", edge.sourceId)
    }
  }
  return { projection, diagnostics, publishable: diagnostics.length === 0 }
}

/** Экспорт проходит строгую проверку, лишние поля отклоняются, а не скрываются. */
export function exportSourceProjection(input: unknown): string {
  return JSON.stringify(sourceProjectionSchema.parse(input))
}
