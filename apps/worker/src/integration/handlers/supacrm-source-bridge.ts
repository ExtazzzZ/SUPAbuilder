import {
  sourceDiagnosticV1Schema,
  sourceIdentityV1Schema,
  sourcePortV1Schema,
} from "@chatbotx.io/flow-config"
import { z } from "zod"

/** T1 RuntimeEvent 1.2.0; authority выдаётся ingress, не UI и не graph. */
export const sourceRuntimeEventV1Schema = z
  .strictObject({
    event_id: z.string().min(1),
    origin: z.enum(["user", "timer", "provider", "operator"]),
    authority_ref: z.string().min(1),
    identity: sourceIdentityV1Schema,
    source_revision: z.string().regex(/^[a-f0-9]{64}$/),
    run_id: z.string(),
    generation: z.number().int().nonnegative(),
    observed_at: z.iso.datetime({ offset: true }),
    payload_ref: z.string(),
    inbound_job_id: z.string().nullable().default(null),
    correlation_ref: z.string().nullable().default(null),
  })
  .refine((event) => event.origin === "user" || event.inbound_job_id === null)

/** T5 AdvanceRequest 1.2.0 (additive generation), без копии backend cursor. */
export const sourceAdvanceRequestV1Schema = z.strictObject({
  event: sourceRuntimeEventV1Schema,
  entry: z.string(),
  max_steps: z.number().int().min(1).max(10_000).default(256),
})
export type SourceAdvanceRequestV1 = z.infer<
  typeof sourceAdvanceRequestV1Schema
>

/** COMMON T1 AdvanceResult source-runtime1.2; private T5 result сюда не передаётся. */
export const sourceAdvanceResultV1Schema = z
  .strictObject({
    run_id: z.string(),
    source_revision: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().nonnegative(),
    status: z.enum([
      "advanced",
      "waiting",
      "unknown",
      "paused",
      "completed",
      "error",
    ]),
    selected_port: z.string().nullable().default(null),
    selected_transition: sourcePortV1Schema.nullable().default(null),
    checkpoint_ref: z.string().nullable().default(null),
    outbound_intent_ids: z.array(z.string()).default([]),
    effect_refs: z.array(z.string()).default([]),
    trace_refs: z.array(z.string()).default([]),
    diagnostics: z.array(sourceDiagnosticV1Schema).default([]),
    reconciliation_ref: z.string().nullable().default(null),
  })
  .refine(
    (result) =>
      result.status !== "unknown" || result.reconciliation_ref !== null,
  )
  .refine(
    (result) =>
      result.status !== "error" ||
      (result.selected_port === null && result.selected_transition === null),
  )
export type SourceAdvanceResultV1 = z.infer<typeof sourceAdvanceResultV1Schema>

export interface SourceRuntimePortV1 {
  /** RuntimeService.advance проверяет authority/pause/generation и возвращает публичный T1 JSON. */
  advance(request: SourceAdvanceRequestV1): Promise<SourceAdvanceResultV1>
}

export type SourceBridgeResult =
  | { status: "checkpoint"; continuation: SourceAdvanceResultV1 }
  | { status: "unknown"; code: "advance_unconfirmed" }
  | {
      status: "error"
      code:
        | "invalid_request"
        | "invalid_response"
        | "run_mismatch"
        | "revision_mismatch"
        | "generation_mismatch"
    }

/** Ровно один вызов; ни dispatch, ни reconcile, ни локальный next-node здесь не запускаются. */
export async function advanceSupacrmSourceV1(
  input: unknown,
  runtime: SourceRuntimePortV1,
): Promise<SourceBridgeResult> {
  const request = sourceAdvanceRequestV1Schema.safeParse(input)
  if (!request.success) {
    return { status: "error", code: "invalid_request" }
  }
  let response: unknown
  try {
    response = await runtime.advance(request.data)
  } catch {
    // Потерянный ответ мог следовать за commit; повтор принадлежит replay/reconciliation backend.
    return { status: "unknown", code: "advance_unconfirmed" }
  }
  const result = sourceAdvanceResultV1Schema.safeParse(response)
  if (!result.success) {
    return { status: "error", code: "invalid_response" }
  }
  if (result.data.run_id !== request.data.event.run_id) {
    return { status: "error", code: "run_mismatch" }
  }
  if (result.data.source_revision !== request.data.event.source_revision) {
    return { status: "error", code: "revision_mismatch" }
  }
  if (result.data.generation !== request.data.event.generation) {
    return { status: "error", code: "generation_mismatch" }
  }
  return { status: "checkpoint", continuation: result.data }
}
