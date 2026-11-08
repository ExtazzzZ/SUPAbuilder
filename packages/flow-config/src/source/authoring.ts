import { z } from "zod"
import {
  parseSourceLogicProjectionV1,
  sourceLogicProjectionV1Schema,
} from "./logic"
import {
  compileSourceProjection,
  type SourceProjection,
  sourceProjectionSchema,
} from "./projection"

/** T7 management/session transport, не S2S execution authority. */
export const sourceAuthoringEnvelopeV1Schema = z
  .strictObject({
    version: z.literal("supacrm.source-authoring.v1"),
    draft_version: z.number().int().nonnegative(),
    source_revision: z.string().min(1),
    source_hash: z.string().optional(),
    projection: sourceProjectionSchema,
    diagnostics: z.array(
      z.strictObject({ code: z.string(), block_id: z.string().optional() }),
    ),
    publishable: z.boolean(),
    logic: sourceLogicProjectionV1Schema.optional(),
    candidate_revision: z.string().optional(),
    published_revision: z.string().optional(),
  })
  .refine(
    (envelope) =>
      envelope.source_revision === envelope.projection.sourceRevision &&
      (!envelope.logic ||
        (envelope.source_hash === envelope.logic.source_hash &&
          envelope.logic.edits.every(
            (edit) => edit.expected_source_hash === envelope.source_hash,
          ))),
  )
export type SourceAuthoringEnvelopeV1 = z.infer<
  typeof sourceAuthoringEnvelopeV1Schema
>

/** Структуру IR изменяет canonical compiler; браузер передаёт только authoring patch с CAS. */
export function buildSourceAuthoringPatchV1(base: unknown, input: unknown) {
  const envelope = sourceAuthoringEnvelopeV1Schema.parse(base)
  const { projection, diagnostics } = compileSourceProjection(input)
  const structure = (p: SourceProjection) => ({
    version: p.version,
    sourceRevision: p.sourceRevision,
    edges: p.edges,
    symbols: p.symbols,
    sourceValidation: p.sourceValidation,
    nodes: p.nodes.map(({ sourceId, scenarioId, kind, ports }) => ({
      sourceId,
      scenarioId,
      kind,
      ports,
    })),
  })
  if (
    JSON.stringify(structure(envelope.projection)) !==
    JSON.stringify(structure(projection))
  ) {
    throw new Error("Структура исходного графа изменена")
  }
  // Известные canonical blockers не мешают сохранению черновика, но остаются в publish validation.
  const signature = (d: { code: string; nodeId?: string; symbolId?: string }) =>
    JSON.stringify([d.code, d.nodeId, d.symbolId])
  const existing = new Set(
    compileSourceProjection(envelope.projection).diagnostics.map(signature),
  )
  if (diagnostics.some((d) => !existing.has(signature(d)))) {
    throw new Error("Неверный авторский patch")
  }
  return {
    version: "supacrm.source-authoring-patch.v1" as const,
    source_revision: envelope.source_revision,
    expected_draft_version: envelope.draft_version,
    updates: projection.nodes.map((node) => {
      if (!node.scenarioId) {
        throw new Error("Отсутствует исходный сценарий")
      }
      return {
        scenario_id: node.scenarioId,
        block_id: node.sourceId,
        label: node.label,
        content: node.content,
        bindings: node.bindings,
        position: node.position,
      }
    }),
  }
}

/** T7 compile transport: полный IR pin отдельно от raw source_hash в T1 edits. */
export function buildSourceLogicCompileRequestV1(
  base: unknown,
  input: unknown,
) {
  const envelope = sourceAuthoringEnvelopeV1Schema.parse(base)
  const logic = parseSourceLogicProjectionV1(input)
  if (
    !(envelope.logic && envelope.source_hash) ||
    logic.source_hash !== envelope.logic.source_hash
  ) {
    throw new Error("Логика исходной ревизии устарела")
  }
  if (
    logic.edits.some(
      (edit) => edit.expected_source_hash !== envelope.source_hash,
    )
  ) {
    throw new Error("Исходный hash правки изменён")
  }
  const identity = (edit: (typeof logic.edits)[number]) =>
    JSON.stringify([edit.kind, edit.target])
  const existing = new Map(
    envelope.logic.edits.map((edit) => [identity(edit), edit]),
  )
  for (const edit of logic.edits) {
    const previous = existing.get(identity(edit))
    if (
      !previous ||
      (edit.kind === "transition" &&
        previous.kind === "transition" &&
        JSON.stringify(edit.port) !== JSON.stringify(previous.port))
    ) {
      throw new Error("Происхождение исходной правки изменено")
    }
  }
  return {
    version: "supacrm.source-logic-authoring.v1" as const,
    source_revision: envelope.source_revision,
    expected_draft_version: envelope.draft_version,
    edits: logic.edits.filter(
      (edit) =>
        JSON.stringify(edit) !== JSON.stringify(existing.get(identity(edit))),
    ),
  }
}
