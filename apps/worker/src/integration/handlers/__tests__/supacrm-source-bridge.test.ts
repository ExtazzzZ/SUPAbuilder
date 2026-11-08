import { expect, test, vi } from "vitest"
import { advanceSupacrmSourceV1 } from "../supacrm-source-bridge"

const fullPin = "a".repeat(64)
const request = () => ({
  event: {
    event_id: "event",
    origin: "user",
    authority_ref: "synthetic-authority",
    identity: {
      project_id: "project",
      platform: "telegram",
      bot_id: "bot",
      peer_id: "peer",
      source_user_id: "user",
      source_chat_id: "chat",
      channel_id: "channel",
    },
    source_revision: fullPin,
    run_id: "run",
    generation: 2,
    observed_at: "2026-11-05T12:00:00+05:00",
    payload_ref: "synthetic-payload",
    inbound_job_id: "job",
    correlation_ref: null,
  },
  entry: "block",
  max_steps: 256,
})
const response = (status = "completed") => ({
  run_id: "run",
  source_revision: fullPin,
  generation: 2,
  status,
  selected_port: null,
  selected_transition: null,
  checkpoint_ref: "source-checkpoint:synthetic",
  outbound_intent_ids: [],
  effect_refs: [],
  trace_refs: [],
  diagnostics: [],
  reconciliation_ref: status === "unknown" ? "reconciliation:synthetic" : null,
})

test.each([
  "advanced",
  "waiting",
  "unknown",
  "paused",
  "error",
  "completed",
])("принимает публичный T1 %s без второго cursor/dispatch", async (status) => {
  const reply = response(status)
  const runtime = { advance: vi.fn().mockResolvedValue(reply) }
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "checkpoint",
    continuation: reply,
  })
  expect(runtime.advance).toHaveBeenCalledExactlyOnceWith(request())
})

test.each([
  ["run_id", "other", "run_mismatch"],
  ["source_revision", "b".repeat(64), "revision_mismatch"],
  ["generation", 3, "generation_mismatch"],
  ["generation", 1, "generation_mismatch"],
])("отклоняет несовпадающий %s=%s без повторного advance", async (field, value, code) => {
  const runtime = {
    advance: vi.fn().mockResolvedValue({ ...response(), [field]: value }),
  }
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "error",
    code,
  })
  expect(runtime.advance).toHaveBeenCalledTimes(1)
})

test("unknown требует public reconciliation_ref, private continuation_id не является fallback", async () => {
  const runtime = {
    advance: vi
      .fn()
      .mockResolvedValue({ ...response("unknown"), reconciliation_ref: null }),
  }
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "error",
    code: "invalid_response",
  })
  runtime.advance.mockResolvedValue({
    ...response("unknown"),
    reconciliation_ref: null,
    continuation_id: "private",
  })
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "error",
    code: "invalid_response",
  })
})

test("backend error не выбирает отрицательный или null-name transition", async () => {
  const transition = {
    scenario_id: "scenario",
    block_id: "block",
    source_path: "transitions.no",
    name: null,
    target_block_id: "otherwise",
    sequence: 0,
  }
  const runtime = {
    advance: vi
      .fn()
      .mockResolvedValue({ ...response("error"), selected_port: "no" }),
  }
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "error",
    code: "invalid_response",
  })
  runtime.advance.mockResolvedValue({
    ...response("error"),
    selected_transition: transition,
  })
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "error",
    code: "invalid_response",
  })
})

test("сохраняет public diagnostics, outbound intents и exact source transition", async () => {
  const transition = {
    scenario_id: "scenario",
    block_id: "block",
    source_path: "transitions.yes",
    name: "yes",
    target_block_id: null,
    sequence: 0,
  }
  const reply = {
    ...response("waiting"),
    selected_port: "yes",
    selected_transition: transition,
    outbound_intent_ids: ["synthetic-outbound"],
    diagnostics: [
      {
        code: "synthetic_diagnostic",
        severity: "info",
        span: {
          scenario_id: "scenario",
          block_id: "block",
          path: "runtime",
          start: 0,
          end: 0,
          sequence: 0,
        },
        related_ids: [],
      },
    ],
  }
  const runtime = { advance: vi.fn().mockResolvedValue(reply) }
  expect(await advanceSupacrmSourceV1(request(), runtime)).toEqual({
    status: "checkpoint",
    continuation: reply,
  })
})

test.each([
  "continuation_id",
  "outbound_refs",
  "selected_path",
  "error",
  "values",
])("отвергает private/несогласованное поле %s", async (field) => {
  const runtime = {
    advance: vi
      .fn()
      .mockResolvedValue({ ...response(), [field]: "synthetic-secret" }),
  }
  const result = await advanceSupacrmSourceV1(request(), runtime)
  expect(result).toEqual({ status: "error", code: "invalid_response" })
  expect(JSON.stringify(result)).not.toContain("synthetic-secret")
})

test.each([
  "effect_pending",
  "running",
  "other",
])("не принимает private/неизвестный status %s", async (status) => {
  expect(
    await advanceSupacrmSourceV1(request(), {
      advance: vi.fn().mockResolvedValue(response(status)),
    }),
  ).toEqual({ status: "error", code: "invalid_response" })
})

test("потерянный ответ остаётся unknown, без автоматического повтора", async () => {
  const runtime = {
    advance: vi.fn().mockRejectedValue(new Error("synthetic-secret")),
  }
  const result = await advanceSupacrmSourceV1(request(), runtime)
  expect(result).toEqual({ status: "unknown", code: "advance_unconfirmed" })
  expect(runtime.advance).toHaveBeenCalledTimes(1)
})

test("timer/provider/operator не подделывает inbound job", async () => {
  const runtime = { advance: vi.fn() }
  for (const origin of ["timer", "provider", "operator"]) {
    const input = request()
    input.event.origin = origin
    expect(await advanceSupacrmSourceV1(input, runtime)).toEqual({
      status: "error",
      code: "invalid_request",
    })
  }
  expect(runtime.advance).not.toHaveBeenCalled()
})

test("не принимает raw/неполный pin вместо full compiled IR hash", async () => {
  const input = request()
  input.event.source_revision = "raw-source-alias"
  const runtime = { advance: vi.fn() }
  expect(await advanceSupacrmSourceV1(input, runtime)).toEqual({
    status: "error",
    code: "invalid_request",
  })
  expect(runtime.advance).not.toHaveBeenCalled()
})

test("после restart принимает только advance новой generation с новым event", async () => {
  const input = request()
  input.event.generation = 3
  input.event.event_id = "after-restart"
  const runtime = {
    advance: vi.fn().mockResolvedValue({ ...response(), generation: 3 }),
  }
  expect(await advanceSupacrmSourceV1(input, runtime)).toMatchObject({
    status: "checkpoint",
    continuation: { generation: 3 },
  })
  expect(runtime.advance).toHaveBeenCalledExactlyOnceWith(input)
})
