import { z } from "zod"
import {
  compileSourceProjection,
  type SourceProjection,
  type SourceSymbolMetadata,
  sourceKinds,
} from "./projection"

/** Wire-модели T1 1.2.0 (saved revision 1.1.0 совместим) из backend/app/schemas/source_runtime.py. */
const string = z.string()
const sourceType = z.enum([
  "str",
  "num",
  "list",
  "dict",
  "bool",
  "attachment",
  "expr",
  "date",
  "datetime",
])
const sourceSpan = z
  .strictObject({
    scenario_id: string,
    block_id: string,
    path: string,
    start: z.number().int().nonnegative().default(0),
    end: z.number().int().nonnegative().default(0),
    sequence: z.number().int().nonnegative().default(0),
  })
  .refine((s) => s.end >= s.start)
const diagnostic = z.strictObject({
  code: string,
  severity: z.enum(["error", "warning", "info"]).default("error"),
  span: sourceSpan,
  related_ids: z.array(string).default([]),
})
const symbolBinding = z
  .strictObject({
    symbol_id: string,
    raw_key: string,
    key: string,
    declared_type: sourceType,
    scope: z.enum(["project", "user", "builtin", "run", "block", "loop"]),
    owner: string,
    definition_revision: string,
    protected: z.boolean(),
    lifetime: z.enum([
      "declaration",
      "event",
      "run",
      "block",
      "loop",
      "unresolved",
    ]),
    default_policy: z.enum(["missing", "reference", "unresolved"]),
    default_ref: string.nullable().default(null),
    sensitivity: z.enum(["ordinary", "protected", "secret", "unresolved"]),
    read_strategy: z.enum([
      "state",
      "projection",
      "builtin",
      "local",
      "unresolved",
    ]),
    write_strategy: z.enum([
      "cas",
      "command",
      "readonly",
      "local",
      "unresolved",
    ]),
    reset_policy: z.enum(["declaration_default", "context", "unresolved"]),
    units: string.nullable().default(null),
  })
  .refine(
    (s) =>
      s.raw_key === `%${s.key}%` &&
      (s.default_policy === "reference") === (s.default_ref !== null) &&
      !(s.protected && s.sensitivity === "ordinary") &&
      !(s.scope === "builtin" && s.write_strategy !== "readonly"),
  )
export const canonicalSourceRevisionV1Schema = z.strictObject({
  contract_version: z.enum(["1.1.0", "1.2.0"]).default("1.2.0"),
  source_hash: string,
  compiler_version: string,
  policy_revision: string,
  scenarios: z.array(string),
  nodes: z.array(
    z.strictObject({
      scenario_id: string,
      block_id: string,
      kind: string,
      ports: z.array(
        z.strictObject({
          scenario_id: string,
          block_id: string,
          source_path: string,
          name: string.nullable(),
          target_block_id: string.nullable(),
          sequence: z.number().int().nonnegative(),
        }),
      ),
      payload_ref: string,
      expression_refs: z.array(string).default([]),
      executable: z.boolean().default(false),
    }),
  ),
  symbols: z.array(symbolBinding),
  source_map: z.array(sourceSpan),
  credential_refs: z.array(string).default([]),
  diagnostics: z.array(diagnostic).default([]),
  declaration_registry_complete: z.boolean().default(false),
  semantic_parity_verified: z.boolean().default(false),
})
export type CanonicalSourceRevisionV1 = z.infer<
  typeof canonicalSourceRevisionV1Schema
>

function metadata(symbol: z.infer<typeof symbolBinding>): SourceSymbolMetadata {
  const secret =
    symbol.sensitivity === "secret" || symbol.sensitivity === "unresolved"
  const operations: SourceSymbolMetadata["operations"] = []
  if (!secret && symbol.read_strategy !== "unresolved") {
    operations.push("read")
  }
  if (
    !secret &&
    symbol.lifetime !== "unresolved" &&
    symbol.write_strategy === "command"
  ) {
    operations.push("command")
  }
  if (
    !secret &&
    symbol.lifetime !== "unresolved" &&
    ["cas", "local"].includes(symbol.write_strategy)
  ) {
    operations.push("set")
    if (symbol.reset_policy !== "unresolved") {
      operations.push("reset")
    }
  }
  let policy: SourceSymbolMetadata["policy"] = "read_only"
  if (["cas", "local"].includes(symbol.write_strategy)) {
    policy = "state"
  }
  if (symbol.write_strategy === "command") {
    policy = "native_command"
  }
  if (secret) {
    policy = "secret_ref"
  }
  return {
    id: symbol.symbol_id,
    name: symbol.key,
    scope: symbol.scope,
    valueType: symbol.declared_type,
    owner: symbol.owner,
    policy,
    operations,
    declaration: {
      rawKey: symbol.raw_key,
      definitionRevision: symbol.definition_revision,
      protected: symbol.protected,
      lifetime: symbol.lifetime,
      defaultPolicy: symbol.default_policy,
      sensitivity: symbol.sensitivity,
      readStrategy: symbol.read_strategy,
      writeStrategy: symbol.write_strategy,
      resetPolicy: symbol.reset_policy,
      units: symbol.units,
    },
  }
}

export const sourcePortHandleV1 = (
  sequence: number,
  name: string | null,
): string => JSON.stringify([sequence, name])

/** Значения payload/default/credential не переходят в browser; разрешение ссылок только серверное. */
export function projectCanonicalSourceV1(input: unknown, revisionId: string) {
  const revision = canonicalSourceRevisionV1Schema.parse(input)
  const projection: SourceProjection = {
    version: "supacrm.source-projection.v1",
    sourceRevision: z.string().min(1).parse(revisionId),
    symbols: revision.symbols.map(metadata),
    sourceValidation: {
      registryComplete: revision.declaration_registry_complete,
      semanticParityVerified: revision.semantic_parity_verified,
      diagnostics: [
        ...revision.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => ({ code: d.code, blockId: d.span.block_id })),
        ...revision.nodes
          .filter((n) => !n.executable)
          .map((n) => ({ code: "node_not_executable", blockId: n.block_id })),
      ],
    },
    nodes: revision.nodes.map((node, index) => {
      if (!sourceKinds.includes(node.kind as (typeof sourceKinds)[number])) {
        throw new Error("Неподдерживаемый kind канонического IR")
      }
      return {
        sourceId: node.block_id,
        scenarioId: node.scenario_id,
        kind: node.kind as (typeof sourceKinds)[number],
        label: node.kind,
        ports: node.ports.map((port) => ({
          id: sourcePortHandleV1(port.sequence, port.name),
          label: port.name ?? "∅",
          source: {
            scenarioId: port.scenario_id,
            blockId: port.block_id,
            path: port.source_path,
            name: port.name,
            targetBlockId: port.target_block_id,
            sequence: port.sequence,
          },
        })),
        bindings: [],
        content: {},
        position: { x: (index % 8) * 320, y: Math.floor(index / 8) * 180 },
      }
    }),
    edges: revision.nodes.flatMap((node) =>
      node.ports.flatMap((port) =>
        port.target_block_id === null
          ? []
          : [
              {
                id: JSON.stringify([
                  node.scenario_id,
                  node.block_id,
                  port.sequence,
                  port.name,
                ]),
                sourceId: node.block_id,
                portId: sourcePortHandleV1(port.sequence, port.name),
                targetId: port.target_block_id,
              },
            ],
      ),
    ),
  }
  return compileSourceProjection(projection)
}

/** Никакой пересборки IR из обеднённого UI: исходная ревизия остаётся серверной. */
export function sourceAuthoringPatchV1(
  base: unknown,
  edited: unknown,
  revisionId: string,
) {
  const revision = canonicalSourceRevisionV1Schema.parse(base)
  const compiled = compileSourceProjection(edited)
  if (compiled.projection.sourceRevision !== revisionId) {
    throw new Error("Ревизия проекции устарела")
  }
  const expected = projectCanonicalSourceV1(revision, revisionId).projection
  const structural = (p: SourceProjection) => ({
    nodes: p.nodes.map((n) => ({
      sourceId: n.sourceId,
      scenarioId: n.scenarioId,
      kind: n.kind,
      ports: n.ports,
    })),
    sourceValidation: p.sourceValidation,
    edges: p.edges,
    symbols: p.symbols,
  })
  if (
    JSON.stringify(structural(expected)) !==
    JSON.stringify(structural(compiled.projection))
  ) {
    throw new Error("Изменение структуры требует канонического compiler")
  }
  if (!compiled.publishable) {
    throw new Error("Неверная редакторская проекция")
  }
  return {
    version: "supacrm.source-authoring-patch.v1" as const,
    source_revision: revisionId,
    updates: compiled.projection.nodes.map((node) => ({
      scenario_id: node.scenarioId,
      block_id: node.sourceId,
      label: node.label,
      content: node.content,
      bindings: node.bindings,
      position: node.position,
    })),
  }
}
