// @vitest-environment node
import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { afterEach, expect, test, vi } from "vitest"
import {
  createNativeSourceBrowserPort,
  createNativeSourceEditorPort,
} from "../src/features/flows/supacrm-source/native/document-port"
import type { NativeSourceBinding } from "../src/lib/source-authoring-native/authorization"

const registry = "11111111-1111-4111-8111-111111111111"
const pin = "a".repeat(64)
const hash = "b".repeat(64)
const binding = (): NativeSourceBinding => ({
  kind: "source",
  bindingId: "binding-1",
  workspaceId: "12",
  flowId: "34",
  registryId: registry,
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
})
const envelope = (draft = 4): SourceAuthoringEnvelopeV1 => ({
  version: "supacrm.source-authoring.v1",
  source_revision: pin,
  source_hash: hash,
  draft_version: draft,
  diagnostics: [],
  publishable: false,
  projection: {
    version: "supacrm.source-projection.v1",
    sourceRevision: pin,
    nodes: [],
    edges: [],
    symbols: [],
  },
  logic: {
    dto_version: "1.0.0",
    source_hash: hash,
    edits: [],
    diagnostics: [],
    publishable: false,
  },
})
const target = {
  scenario_id: "s",
  block_id: "b",
  path: "params.markup",
  start: 0,
  end: 0,
  sequence: 0,
}
const descriptor = {
  field_id: "field",
  target,
  handler_id: "source-presentation/1",
  policy_revision: "p1",
  descriptor_version: "d1",
  schema_ref: "source.message.plain-text/1",
}
const expected = {
  expected_full_ir_id: pin,
  expected_source_hash: hash,
  expected_draft_version: 4,
}
const slot = {
  kind: "literal_slot" as const,
  slot_id: "safe-slot",
  declared_type: "str" as const,
}
const viewRequest = {
  schema_version: "message-field-view-request/1" as const,
  field_id: "field",
  expected_full_ir_id: pin,
  expected_draft_version: 4,
}
const write = {
  ...descriptor,
  ...expected,
  schema_version: "message-field-slot/1" as const,
  text: "Текст",
}
const edit = {
  ...descriptor,
  ...expected,
  schema_version: "message-field-edit/1" as const,
  template: { context: "text" as const, runs: [slot] },
}
const view = {
  ...descriptor,
  schema_version: "message-field-view/1",
  source_revision: pin,
  source_hash: hash,
  draft_version: 4,
  slot,
  text: write.text,
}
const surface = {
  schema_version: "source-authoring-surface/1",
  source_revision: pin,
  source_hash: hash,
  draft_version: 4,
  fields: [],
  unsupported_field_ids: [],
  production: false,
  publishable: false,
}
afterEach(() => vi.unstubAllGlobals())
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Нет синтетического fixture")
  }
  return value
}

test("без явного transport нет legacy fallback или скрытого fetch", () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  expect(() => createNativeSourceEditorPort(binding())).toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

test.each([
  null,
  {},
  { ...binding(), kind: "legacy" },
  { ...binding(), workspaceId: "../other" },
  { ...binding(), flowId: "0" },
  { ...binding(), registryId: "other" },
  { ...binding(), bindingId: "" },
  { ...binding(), bindingVersion: 2 },
  { ...binding(), capabilities: ["view", 3] },
  { ...binding(), actor: "client-actor" },
])("неверный descriptor отвергается до HTTP: %j", (value) => {
  const request = vi.fn<typeof fetch>()
  expect(() =>
    createNativeSourceEditorPort(value as NativeSourceBinding, request),
  ).toThrow()
  expect(request).not.toHaveBeenCalled()
})

test("все девять typed методов используют flow scoped маршруты и сохраняют CAS", async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const request: typeof fetch = function (this: unknown, url, init) {
    expect(this).toBeUndefined()
    const path = String(url)
    calls.push({ path, init })
    const suffix = path.split("/source-runtime/")[1]
    let body: unknown = envelope()
    if (suffix === "message-fields") {
      body = surface
    } else if (
      suffix === "message-fields/view" ||
      suffix === "message-fields/slot"
    ) {
      body = view
    } else if (suffix === "publish") {
      body = { ...envelope(), published_revision: pin }
    } else if (
      suffix === "draft" ||
      suffix === "compile" ||
      suffix === "message-fields/compile"
    ) {
      body = envelope(5)
    }
    return Promise.resolve(Response.json(body))
  }
  const port = createNativeSourceEditorPort(binding(), request)
  const base = envelope()
  const abort = new AbortController()
  expect(await port.load(abort.signal)).toEqual(base)
  expect((await port.save(base, base.projection)).draft_version).toBe(5)
  expect(
    (await port.compileLogic(base, required(base.logic))).draft_version,
  ).toBe(5)
  expect(await port.validate(base)).toEqual(base)
  expect((await port.publish(base)).published_revision).toBe(pin)
  expect(await port.messageFields(abort.signal)).toEqual(surface)
  expect(await port.messageView(viewRequest, hash)).toEqual(view)
  expect(await port.messageSlot(write)).toEqual(view)
  expect((await port.messageCompile(edit)).draft_version).toBe(5)
  const suffixes = [
    "projection",
    "draft",
    "compile",
    "validate",
    "publish",
    "message-fields",
    "message-fields/view",
    "message-fields/slot",
    "message-fields/compile",
  ]
  const methods = [
    "GET",
    "PATCH",
    "POST",
    "POST",
    "POST",
    "GET",
    "POST",
    "POST",
    "POST",
  ]
  expect(calls).toHaveLength(9)
  calls.forEach(({ path, init }, index) => {
    expect(path).toBe(
      `/api/workspaces/12/flows/34/source-runtime/${suffixes[index]}`,
    )
    expect(path).not.toContain(registry)
    expect(init?.method).toBe(methods[index])
    expect(init?.credentials).toBe("same-origin")
    expect(init?.cache).toBe("no-store")
    expect(init?.headers).toEqual(
      methods[index] === "GET"
        ? undefined
        : { "Content-Type": "application/json" },
    )
    if (methods[index] !== "GET") {
      const body = JSON.parse(String(init?.body))
      expect(body.expected_draft_version).toBe(4)
      expect(body.source_revision ?? body.expected_full_ir_id).toBe(pin)
    }
  })
  expect(calls[0]?.init?.signal).toBe(abort.signal)
  expect(calls[5]?.init?.signal).toBe(abort.signal)
  expect(JSON.parse(String(calls[8]?.init?.body))).toEqual(edit)
  expect(JSON.parse(String(calls[6]?.init?.body))).toEqual(viewRequest)
})

test("копия descriptor и capabilities не позволяет переназначить flow после создания", async () => {
  const descriptor = { ...binding(), capabilities: [...binding().capabilities] }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(envelope()))
  const port = createNativeSourceEditorPort(descriptor, request)
  descriptor.workspaceId = "99"
  descriptor.flowId = "88"
  descriptor.registryId = "22222222-2222-4222-8222-222222222222"
  descriptor.capabilities.length = 0
  await port.load()
  expect(request.mock.calls[0]?.[0]).toBe(
    "/api/workspaces/12/flows/34/source-runtime/projection",
  )
})

test.each([
  "view",
  "slot",
  "compile",
  "validate",
  "publish",
])("отсутствующая capability %s запрещает соответствующую группу без HTTP", async (capability) => {
  const descriptor = {
    ...binding(),
    capabilities: binding().capabilities.filter(
      (value) => value !== capability,
    ),
  }
  const request = vi.fn<typeof fetch>()
  const port = createNativeSourceEditorPort(descriptor, request)
  const base = envelope()
  const groupedActions = {
    view: [
      () => port.load(),
      () => port.messageFields(),
      () => port.messageView(viewRequest, hash),
    ],
    slot: [() => port.messageSlot(write)],
    compile: [
      () => port.save(base, base.projection),
      () => port.compileLogic(base, required(base.logic)),
      () => port.messageCompile(edit),
    ],
    validate: [() => port.validate(base)],
    publish: [() => port.publish(base)],
  }
  for (const action of groupedActions[
    capability as keyof typeof groupedActions
  ]) {
    await expect(action()).rejects.toThrow()
  }
  expect(request).not.toHaveBeenCalled()
})

test("browser factory передаёт native fetch без receiver экземпляра", async () => {
  const request = vi.fn(function (this: unknown) {
    expect(this).toBeUndefined()
    return Promise.resolve(Response.json(envelope()))
  })
  vi.stubGlobal("fetch", request)
  expect(await createNativeSourceBrowserPort(binding()).load()).toEqual(
    envelope(),
  )
  expect(request).toHaveBeenCalledTimes(1)
})

test("unknown mutation не повторяется и не раскрывает network error", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("PRIVATE_ACTOR_TOKEN"))
  const port = createNativeSourceEditorPort(binding(), request)
  const base = envelope()
  await expect(port.save(base, base.projection)).rejects.toMatchObject({
    code: "save_unconfirmed",
    message: "save_unconfirmed",
  })
  expect(request).toHaveBeenCalledTimes(1)
})

test.each([
  [409, "conflict"],
  [422, "validation_rejected"],
  [500, "unknown"],
] as const)("message HTTP %s сохраняет существующую классификацию без чтения деталей", async (status, code) => {
  const response = Response.json({ private: "SECRET" }, { status })
  const json = vi.spyOn(response, "json")
  const request = vi.fn<typeof fetch>().mockResolvedValue(response)
  const operation = createNativeSourceEditorPort(
    binding(),
    request,
  ).messageCompile(edit)
  await expect(operation).rejects.toMatchObject({
    code,
  })
  expect(request).toHaveBeenCalledTimes(1)
  expect(json).not.toHaveBeenCalled()
})

test("invalid200 остаётся unknown и не повторяет message mutation", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ payload_ref: "PRIVATE" }))
  await expect(
    createNativeSourceEditorPort(binding(), request).messageCompile(edit),
  ).rejects.toMatchObject({ code: "unknown" })
  expect(request).toHaveBeenCalledTimes(1)
})
