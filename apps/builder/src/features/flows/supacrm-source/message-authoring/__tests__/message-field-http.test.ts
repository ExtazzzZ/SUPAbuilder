// @vitest-environment node
import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { expect, test, vi } from "vitest"
import {
  MessageFieldHttpClient,
  MessageFieldHttpError,
} from "../message-field-http"
import { messageFieldSurfaceSchema } from "../message-field-surface"
import { MessageAuthoringRejected } from "../port"
import type {
  MessageFieldEdit,
  MessageLiteralView,
  MessageLiteralWrite,
} from "../wire"

const bot = "11111111-1111-4111-8111-111111111111"
const pin = "a".repeat(64),
  raw = "b".repeat(64)
const target = {
  scenario_id: "scenario",
  block_id: "block",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
const descriptor = {
  field_id: "field-1",
  target,
  handler_id: "source-presentation/1",
  policy_revision: "policy/1",
  descriptor_version: "descriptor/1",
  schema_ref: "source.message.plain-text/1",
}
const scope = {
  expected_full_ir_id: pin,
  expected_source_hash: raw,
  expected_draft_version: 8,
}
const viewRequest = {
  schema_version: "message-field-view-request/1" as const,
  field_id: descriptor.field_id,
  expected_full_ir_id: pin,
  expected_draft_version: 8,
}
const slot = {
  kind: "literal_slot" as const,
  slot_id: "11111111-2222-4333-8444-555555555555",
  declared_type: "str" as const,
}
function surface() {
  return {
    schema_version: "source-authoring-surface/1",
    source_revision: pin,
    source_hash: raw,
    draft_version: 8,
    fields: [
      { ...descriptor, editable: true, code: "ordinary_e1_field" },
      {
        field_id: "field-2",
        target: { ...target, block_id: "other" },
        editable: false,
        code: "message_field_unsupported",
      },
    ],
    unsupported_field_ids: ["field-2"],
    production: false,
    publishable: false,
  }
}
function view(): MessageLiteralView {
  return {
    ...descriptor,
    schema_version: "message-field-view/1",
    source_revision: pin,
    source_hash: raw,
    draft_version: 8,
    slot,
    text: "Обычный текст",
  }
}
function write(): MessageLiteralWrite {
  return {
    ...descriptor,
    ...scope,
    schema_version: "message-field-slot/1",
    text: "Обновлённый текст",
  }
}
function edit(): MessageFieldEdit {
  return {
    ...descriptor,
    ...scope,
    schema_version: "message-field-edit/1",
    template: { context: "text", runs: [slot] },
  }
}
function envelope(): SourceAuthoringEnvelopeV1 {
  return {
    version: "supacrm.source-authoring.v1",
    source_revision: pin,
    source_hash: raw,
    draft_version: 9,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: pin,
      nodes: [],
      edges: [],
      symbols: [],
    },
    logic: {
      dto_version: "1.0.0",
      source_hash: raw,
      edits: [],
      diagnostics: [],
      publishable: false,
    },
    diagnostics: [],
    publishable: false,
  }
}
function required<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("Нет результата проверки")
  }
  return value
}

test("четыре операции используют фиксированные пути и typed DTO без service/auth headers", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(surface()))
    .mockResolvedValueOnce(Response.json(view()))
    .mockResolvedValueOnce(Response.json({ ...view(), text: write().text }))
    .mockResolvedValueOnce(Response.json(envelope()))
  const client = new MessageFieldHttpClient(request),
    controller = new AbortController()
  expect(await client.surface(bot, controller.signal)).toEqual(surface())
  expect(await client.view(bot, viewRequest, raw)).toEqual(view())
  expect(await client.slot(bot, write())).toEqual({
    ...view(),
    text: write().text,
  })
  expect(await client.compile(bot, edit())).toEqual(envelope())
  expect(
    request.mock.calls.map(([path, init]) => [path, init?.method]),
  ).toEqual(
    [
      ["", "GET"],
      ["/view", "POST"],
      ["/slot", "POST"],
      ["/compile", "POST"],
    ].map(([suffix, method]) => [
      `/api/automation/bots/${bot}/source-runtime/message-fields${suffix}`,
      method,
    ]),
  )
  for (const [, init] of request.mock.calls) {
    expect(init?.credentials).toBe("same-origin")
    expect(new Headers(init?.headers).has("authorization")).toBe(false)
    expect(new Headers(init?.headers).has("x-automation-key")).toBe(false)
  }
  expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  for (const index of [1, 2, 3]) {
    expect(request.mock.calls[index]?.[1]?.signal).toBeUndefined()
    expect(
      new Headers(request.mock.calls[index]?.[1]?.headers).get("content-type"),
    ).toBe("application/json")
  }
  expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual(
    viewRequest,
  )
  expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toEqual(write())
  const compiled = JSON.parse(String(request.mock.calls[3]?.[1]?.body))
  expect(compiled).toEqual(edit())
  expect(compiled).not.toHaveProperty("text")
  expect(compiled.template.runs).toEqual([slot])
})

test.each([
  "text",
  "evidence_refs",
  "payload_ref",
  "symbol_refs",
  "CompiledBinding",
])("surface отвергает запрещённое поле %s на обоих уровнях", (key) => {
  expect(
    messageFieldSurfaceSchema.safeParse({
      ...surface(),
      [key]: "synthetic-private",
    }).success,
  ).toBe(false)
  const body = surface()
  body.fields[0] = {
    ...required(body.fields[0]),
    [key]: "synthetic-private",
  } as (typeof body.fields)[number]
  expect(messageFieldSurfaceSchema.safeParse(body).success).toBe(false)
})

test("surface проверяет false gates, уникальность и согласованность unsupported IDs", () => {
  expect(
    messageFieldSurfaceSchema.safeParse({ ...surface(), production: true })
      .success,
  ).toBe(false)
  expect(
    messageFieldSurfaceSchema.safeParse({ ...surface(), publishable: true })
      .success,
  ).toBe(false)
  expect(
    messageFieldSurfaceSchema.safeParse({
      ...surface(),
      unsupported_field_ids: [],
    }).success,
  ).toBe(false)
  expect(
    messageFieldSurfaceSchema.safeParse({
      ...surface(),
      fields: [required(surface().fields[0]), required(surface().fields[0])],
    }).success,
  ).toBe(false)
  const unsupported = surface()
  unsupported.fields[0] = {
    ...required(unsupported.fields[0]),
    handler_id: undefined,
  }
  expect(messageFieldSurfaceSchema.safeParse(unsupported).success).toBe(false)
})

test.each([
  401, 403, 409, 422, 400, 404, 500, 503, 202,
])("HTTP %s классифицируется без чтения error body и без повтора", async (status) => {
  const response = Response.json(
      { text: "synthetic-private-details" },
      { status },
    ),
    read = vi.spyOn(response, "json")
  const request = vi.fn<typeof fetch>().mockResolvedValue(response)
  const operation = new MessageFieldHttpClient(request).compile(bot, edit())
  if (status === 409 || status === 422) {
    await expect(operation).rejects.toBeInstanceOf(MessageAuthoringRejected)
    await expect(operation).rejects.toMatchObject({
      code: status === 409 ? "conflict" : "validation_rejected",
    })
  } else {
    await expect(operation).rejects.toBeInstanceOf(MessageFieldHttpError)
    await expect(operation).rejects.toMatchObject({
      code: status === 401 || status === 403 ? "unauthorized" : "unknown",
    })
  }
  expect(read).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(1)
})

test("потерянный ответ неизвестен без раскрытия исключения и без повторного POST", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("synthetic-private-network"))
  try {
    await new MessageFieldHttpClient(request).slot(bot, write())
    throw new Error("Ожидалась ошибка")
  } catch (error) {
    expect(error).toBeInstanceOf(MessageFieldHttpError)
    expect(error).toMatchObject({ code: "unknown" })
    expect(String(error)).not.toContain("synthetic-private-network")
  }
  expect(request).toHaveBeenCalledTimes(1)
})

test.each([
  "source_revision",
  "source_hash",
  "draft_version",
  "field_id",
])("view response с чужим %s неизвестен", async (key) => {
  const altered = {
    ...view(),
    [key]: key === "draft_version" ? 9 : "c".repeat(64),
  }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(altered))
  await expect(
    new MessageFieldHttpClient(request).view(bot, viewRequest, raw),
  ).rejects.toMatchObject({ code: "unknown" })
  expect(request).toHaveBeenCalledTimes(1)
})

test.each([
  "source_revision",
  "source_hash",
  "draft_version",
  "field_id",
  "target",
  "handler_id",
  "policy_revision",
  "descriptor_version",
  "schema_ref",
  "text",
])("slot response с изменённым %s не принимается", async (key) => {
  let changed: unknown = "foreign"
  if (key === "draft_version") {
    changed = 9
  }
  if (key === "target") {
    changed = { ...target, block_id: "foreign" }
  }
  const altered = { ...view(), text: write().text, [key]: changed }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(altered))
  await expect(
    new MessageFieldHttpClient(request).slot(bot, write()),
  ).rejects.toMatchObject({ code: "unknown" })
})

test.each([
  8, 7, 10,
])("compile требует ровно base+1, отклоняя draft=%s даже при noop", async (draft) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...envelope(), draft_version: draft }))
  await expect(
    new MessageFieldHttpClient(request).compile(bot, edit()),
  ).rejects.toMatchObject({ code: "unknown" })
  expect(request).toHaveBeenCalledTimes(1)
})

test.each([
  "source_hash",
  "logic",
  "projection",
  "foreign",
])("compile отвергает несогласованный envelope %s", async (key) => {
  const body: Record<string, unknown> = envelope()
  if (key === "source_hash") {
    body.source_hash = "c".repeat(64)
  }
  if (key === "logic") {
    body.logic = undefined
  }
  if (key === "projection") {
    body.projection = {
      ...envelope().projection,
      sourceRevision: "c".repeat(64),
    }
  }
  if (key === "foreign") {
    body.payload_ref = "synthetic-private"
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
  await expect(
    new MessageFieldHttpClient(request).compile(bot, edit()),
  ).rejects.toMatchObject({ code: "unknown" })
})

test("invalid200 и malformed JSON не считаются подтверждённым отказом", async () => {
  for (const response of [
    Response.json({ ...view(), payload_ref: "synthetic-private" }),
    new Response("{broken", {
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(
      new MessageFieldHttpClient(request).view(bot, viewRequest, raw),
    ).rejects.toMatchObject({ code: "unknown" })
    expect(request).toHaveBeenCalledTimes(1)
  }
})

test("невалидный bot/path и rawhash в view request отклоняются до fetch", async () => {
  const request = vi.fn<typeof fetch>(),
    client = new MessageFieldHttpClient(request)
  await expect(client.surface("../foreign")).rejects.toMatchObject({
    code: "invalid_request",
  })
  await expect(
    client.view(
      bot,
      { ...viewRequest, expected_source_hash: raw } as typeof viewRequest,
      raw,
    ),
  ).rejects.toMatchObject({ code: "invalid_request" })
  await expect(
    client.slot(bot, {
      ...write(),
      payload_ref: "private",
    } as MessageLiteralWrite),
  ).rejects.toMatchObject({ code: "invalid_request" })
  await expect(
    client.compile(bot, {
      ...edit(),
      template: {
        context: "text",
        runs: [{ kind: "symbol", symbol_id: "forbidden" }],
      },
    } as unknown as MessageFieldEdit),
  ).rejects.toMatchObject({ code: "invalid_request" })
  expect(request).not.toHaveBeenCalled()
})

test("compile принимает новый fullpin/rawhash только в согласованном envelope", async () => {
  const next = envelope()
  next.source_revision = "c".repeat(64)
  next.projection.sourceRevision = next.source_revision
  next.source_hash = "d".repeat(64)
  required(next.logic).source_hash = next.source_hash
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(next))
  expect(
    await new MessageFieldHttpClient(request).compile(bot, edit()),
  ).toEqual(next)
})

test("malformed surface200 имеет неизвестный исход, а не подтверждённый отказ", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ ...surface(), text: "synthetic-private" }),
    )
  await expect(
    new MessageFieldHttpClient(request).surface(bot),
  ).rejects.toMatchObject({ code: "unknown" })
  expect(request).toHaveBeenCalledTimes(1)
})

test("ошибка runtime-validator не раскрывает submitted input", async () => {
  const request = vi.fn<typeof fetch>()
  const invalid = new Proxy(
    {},
    {
      get() {
        throw new Error("synthetic-private-validator")
      },
    },
  )
  const operation = new MessageFieldHttpClient(request).slot(
    bot,
    invalid as MessageLiteralWrite,
  )
  await expect(operation).rejects.toBeInstanceOf(MessageFieldHttpError)
  await expect(operation).rejects.toMatchObject({ code: "invalid_request" })
  expect(request).not.toHaveBeenCalled()
})

test("native fetch brand сохраняется вызовом без receiver HTTP-клиента", async () => {
  let calls = 0
  const request: typeof fetch = function (this: unknown, _input, _init) {
    calls++
    if (this !== undefined) {
      throw new TypeError("Illegal invocation")
    }
    return Promise.resolve(Response.json(surface()))
  }
  expect(await new MessageFieldHttpClient(request).surface(bot)).toEqual(
    surface(),
  )
  expect(calls).toBe(1)
})
