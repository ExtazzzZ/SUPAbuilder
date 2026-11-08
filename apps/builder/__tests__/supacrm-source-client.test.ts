import { expect, test, vi } from "vitest"
import { SourceAuthoringClient } from "../src/features/flows/supacrm-source/source-client"

const bot = "11111111-1111-4111-8111-111111111111"
const envelope = () => ({
  version: "supacrm.source-authoring.v1" as const,
  draft_version: 4,
  source_revision: "source",
  projection: {
    version: "supacrm.source-projection.v1" as const,
    sourceRevision: "source",
    nodes: [
      {
        scenarioId: "scenario",
        sourceId: "block",
        kind: "send_message" as const,
        label: "Тест",
        ports: [],
        bindings: [],
        content: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    symbols: [],
  },
  diagnostics: [],
  publishable: false,
})

test("загрузка и CAS patch используют same-origin BFF, без runtime values", async () => {
  const base = envelope()
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(base))
  const client = new SourceAuthoringClient(request)
  expect(await client.load(bot)).toEqual(base)
  const next = { ...base, draft_version: 5 }
  request.mockResolvedValue(Response.json(next))
  expect(await client.save(bot, base, base.projection)).toEqual(next)
  const [url, init] = request.mock.calls[1] ?? []
  expect(url).toBe(`/api/automation/bots/${bot}/source-runtime/draft`)
  expect(init?.credentials).toBe("same-origin")
  expect(JSON.parse(String(init?.body))).toMatchObject({
    version: "supacrm.source-authoring-patch.v1",
    expected_draft_version: 4,
    source_revision: "source",
    updates: [{ scenario_id: "scenario", block_id: "block" }],
  })
})

test.each([
  409, 401, 403,
])("статус %s не запускает повтор сохранения", async (status) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status }))
  const client = new SourceAuthoringClient(request)
  const base = envelope()
  await expect(client.save(bot, base, base.projection)).rejects.toMatchObject({
    code: status === 409 ? "conflict" : "unauthorized",
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test("потерянный save остаётся unconfirmed без раскрытия тела ошибки", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("synthetic-secret"))
  const client = new SourceAuthoringClient(request)
  const base = envelope()
  await expect(client.save(bot, base, base.projection)).rejects.toMatchObject({
    code: "save_unconfirmed",
    message: "save_unconfirmed",
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test("schema и bot validation не пропускают чужие поля или произвольный URL", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ ...envelope(), credentials: "synthetic-secret" }),
    )
  const client = new SourceAuthoringClient(request)
  await expect(client.load(bot)).rejects.toMatchObject({
    code: "invalid_response",
  })
  request.mockClear()
  await expect(client.load("https://example.org")).rejects.toMatchObject({
    code: "invalid_request",
  })
  expect(request).not.toHaveBeenCalled()
})

test.each([
  "invalid_json",
  "server_error",
  "stale_version",
  "wrong_revision",
])("ответ save %s требует сверки и не повторяет запись", async (kind) => {
  const base = envelope()
  let response: Response
  if (kind === "invalid_json") {
    response = new Response("synthetic-secret")
  } else if (kind === "server_error") {
    response = new Response(null, { status: 502 })
  } else if (kind === "stale_version") {
    response = Response.json(base)
  } else {
    response = Response.json({
      ...base,
      draft_version: 5,
      source_revision: "other",
      projection: { ...base.projection, sourceRevision: "other" },
    })
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(response)
  const client = new SourceAuthoringClient(request)
  await expect(client.save(bot, base, base.projection)).rejects.toMatchObject({
    code: "save_unconfirmed",
    message: "save_unconfirmed",
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test("fetch вызывается без receiver экземпляра клиента, сохраняя native brand", async () => {
  let calls = 0
  const request: typeof fetch = function (this: unknown, _input, _init) {
    calls++
    if (this !== undefined) {
      throw new TypeError("Illegal invocation")
    }
    return Promise.resolve(Response.json(envelope()))
  }
  expect(await new SourceAuthoringClient(request).load(bot)).toEqual(envelope())
  expect(calls).toBe(1)
})
