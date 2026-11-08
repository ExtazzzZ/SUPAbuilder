import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { expect, test, vi } from "vitest"
import { SourceAuthoringClient } from "../src/features/flows/supacrm-source/source-client"

const bot = "11111111-1111-4111-8111-111111111111"
const rawHash = "a".repeat(64)
const pin = "b".repeat(64)
function fixture(): SourceAuthoringEnvelopeV1 {
  return {
    version: "supacrm.source-authoring.v1",
    source_revision: pin,
    source_hash: rawHash,
    draft_version: 5,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: pin,
      nodes: [],
      edges: [],
      symbols: [],
    },
    diagnostics: [],
    publishable: false,
    logic: {
      dto_version: "1.0.0",
      source_hash: rawHash,
      publishable: false,
      diagnostics: [],
      edits: [
        {
          kind: "guard",
          expected_source_hash: rawHash,
          target: {
            scenario_id: "scenario",
            block_id: "block",
            path: "params.expr",
            start: 0,
            end: 0,
            sequence: 0,
          },
          expression: { kind: "symbol", symbol_id: "symbol" },
        },
      ],
    },
  }
}

test("compile передаёт FULL pin отдельно от raw source hash и принимает новую immutable revision", async () => {
  const base = fixture()
  const next = {
    ...base,
    source_revision: "c".repeat(64),
    candidate_revision: "c".repeat(64),
    draft_version: 6,
    projection: { ...base.projection, sourceRevision: "c".repeat(64) },
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(next))
  const client = new SourceAuthoringClient(request)
  const edited = structuredClone(required(base.logic))
  const guard = required(edited.edits[0])
  if (guard.kind === "guard") {
    guard.expression = {
      kind: "unary",
      operator: "not",
      operand: guard.expression,
    }
  }
  expect(await client.compile(bot, base, edited)).toEqual(next)
  const [url, init] = required(request.mock.calls[0])
  expect(url).toBe(`/api/automation/bots/${bot}/source-runtime/compile`)
  expect(init?.method).toBe("POST")
  const body = JSON.parse(String(init?.body))
  expect(body.source_revision).toBe(pin)
  expect(body.expected_draft_version).toBe(5)
  expect(body.edits[0].expected_source_hash).toBe(rawHash)
})

test("422 compile diagnostics доступны без raw body и без повторов", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        version: "supacrm.source-authoring.v1",
        diagnostics: [
          { code: "authoring_function_unregistered", block_id: "block" },
        ],
        publishable: false,
      },
      { status: 422 },
    ),
  )
  const base = fixture()
  await expect(
    new SourceAuthoringClient(request).compile(bot, base, required(base.logic)),
  ).rejects.toMatchObject({
    code: "compile_rejected",
    diagnostics: [
      { code: "authoring_function_unregistered", block_id: "block" },
    ],
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test("validate/publish используют текущий full pin, publication не меняет bot binding", async () => {
  const base = { ...fixture(), publishable: true }
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(base))
  const client = new SourceAuthoringClient(request)
  expect(await client.validate(bot, base)).toEqual(base)
  request.mockResolvedValue(Response.json({ ...base, published_revision: pin }))
  expect((await client.publish(bot, base)).published_revision).toBe(pin)
  for (const [, init] of request.mock.calls) {
    expect(JSON.parse(String(init?.body))).toEqual({
      version: "supacrm.source-publish.v1",
      source_revision: pin,
      expected_draft_version: 5,
    })
  }
})

test("publish gate409 возвращает конкретные diagnostics без повторной записи", async () => {
  const base = fixture()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { ...base, diagnostics: [{ code: "registry_incomplete" }] },
        { status: 409 },
      ),
    )
  await expect(
    new SourceAuthoringClient(request).publish(bot, base),
  ).rejects.toMatchObject({
    code: "publish_blocked",
    diagnostics: [{ code: "registry_incomplete" }],
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test("подмена raw hash/target происхождения не попадает в compile POST", async () => {
  const base = fixture()
  const logic = structuredClone(required(base.logic))
  required(logic.edits[0]).target.path = "arbitrary.setter"
  const request = vi.fn<typeof fetch>()
  await expect(
    new SourceAuthoringClient(request).compile(bot, base, logic),
  ).rejects.toMatchObject({ code: "invalid_request" })
  expect(request).not.toHaveBeenCalled()
})

test.each([
  "compile",
  "publish",
] as const)("потерянный %s response не запускает повтор", async (action) => {
  const base = fixture()
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("synthetic-secret"))
  const client = new SourceAuthoringClient(request)
  const result =
    action === "compile"
      ? client.compile(bot, base, required(base.logic))
      : client.publish(bot, base)
  await expect(result).rejects.toMatchObject({
    code: "save_unconfirmed",
    message: "save_unconfirmed",
  })
  expect(request).toHaveBeenCalledTimes(1)
})
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Нет синтетического fixture")
  }
  return value
}

test("compile200 без полного logic snapshot не стирает локальные правки", async () => {
  const base = fixture()
  const next = {
    ...base,
    draft_version: 6,
    source_revision: "c".repeat(64),
    projection: { ...base.projection, sourceRevision: "c".repeat(64) },
    logic: undefined,
    source_hash: undefined,
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(next))
  await expect(
    new SourceAuthoringClient(request).compile(bot, base, required(base.logic)),
  ).rejects.toMatchObject({ code: "save_unconfirmed" })
  expect(request).toHaveBeenCalledTimes(1)
})

test("validate ответа другой draft version недостаточно для публикации запрошенной версии", async () => {
  const base = fixture()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ ...base, draft_version: 6, publishable: true }),
    )
  await expect(
    new SourceAuthoringClient(request).validate(bot, base),
  ).rejects.toMatchObject({ code: "invalid_response" })
})
