import type {
  SourceAuthoringEnvelopeV1,
  SourceLogicProjectionV1,
  SourceProjection,
} from "@chatbotx.io/flow-config"
import { z } from "zod"
import type { NativeSourceBinding } from "@/lib/source-authoring-native/authorization"
import { MessageFieldHttpClient } from "../message-authoring/message-field-http"
import type { MessageFieldSurface } from "../message-authoring/message-field-surface"
import type {
  MessageFieldEdit,
  MessageLiteralView,
  MessageLiteralViewRequest,
  MessageLiteralWrite,
} from "../message-authoring/wire"
import { SourceAuthoringClient } from "../source-client"

export interface NativeSourceEditorPort {
  compileLogic(
    base: SourceAuthoringEnvelopeV1,
    logic: SourceLogicProjectionV1,
  ): Promise<SourceAuthoringEnvelopeV1>
  load(signal?: AbortSignal): Promise<SourceAuthoringEnvelopeV1>
  messageCompile(edit: MessageFieldEdit): Promise<SourceAuthoringEnvelopeV1>
  messageFields(signal?: AbortSignal): Promise<MessageFieldSurface>
  messageSlot(write: MessageLiteralWrite): Promise<MessageLiteralView>
  messageView(
    request: MessageLiteralViewRequest,
    expectedSourceHash: string,
  ): Promise<MessageLiteralView>
  publish(base: SourceAuthoringEnvelopeV1): Promise<SourceAuthoringEnvelopeV1>
  save(
    base: SourceAuthoringEnvelopeV1,
    projection: SourceProjection,
  ): Promise<SourceAuthoringEnvelopeV1>
  validate(base: SourceAuthoringEnvelopeV1): Promise<SourceAuthoringEnvelopeV1>
}

const nativeId = z.string().regex(/^[1-9][0-9]{0,19}$/)
const bindingSchema = z.strictObject({
  kind: z.literal("source"),
  bindingId: z.string().min(1),
  workspaceId: nativeId,
  flowId: nativeId,
  registryId: z.uuid(),
  bindingVersion: z.literal(1),
  capabilities: z.array(z.string()),
})
const actions = {
  projection: { method: "GET", capability: "view" },
  draft: { method: "PATCH", capability: "compile" },
  compile: { method: "POST", capability: "compile" },
  validate: { method: "POST", capability: "validate" },
  publish: { method: "POST", capability: "publish" },
  "message-fields": { method: "GET", capability: "view" },
  "message-fields/view": { method: "POST", capability: "view" },
  "message-fields/slot": { method: "POST", capability: "slot" },
  "message-fields/compile": { method: "POST", capability: "compile" },
} as const

/** Metadata ограничивает маршрут; каждый вызов заново авторизуется owning BFF по session/binding. */
export function createNativeSourceEditorPort(
  binding: NativeSourceBinding,
  request?: typeof fetch,
): NativeSourceEditorPort {
  let descriptor: NativeSourceBinding
  try {
    const parsed = bindingSchema.parse(binding)
    descriptor = Object.freeze({
      ...parsed,
      capabilities: Object.freeze([...parsed.capabilities]),
    })
    if (typeof request !== "function") {
      throw new Error("native_source_transport_unavailable")
    }
  } catch {
    throw new Error("native_source_transport_unavailable")
  }
  const send = request
  const prefix = `/api/automation/bots/${descriptor.registryId}/source-runtime/`
  const destination = `/api/workspaces/${descriptor.workspaceId}/flows/${descriptor.flowId}/source-runtime/`
  const mappedRequest: typeof fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith(prefix)) {
      throw new Error("native_source_transport_unavailable")
    }
    const suffix = input.slice(prefix.length)
    if (!Object.hasOwn(actions, suffix)) {
      throw new Error("native_source_transport_unavailable")
    }
    const action = actions[suffix as keyof typeof actions]
    if (
      init?.method !== action.method ||
      !descriptor.capabilities.includes(action.capability) ||
      (action.method !== "GET" && typeof init.body !== "string")
    ) {
      throw new Error("native_source_transport_unavailable")
    }
    // Не переносим произвольные headers, actor, service key или credentials из клиента.
    return await send(`${destination}${suffix}`, {
      method: action.method,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
      ...(action.method === "GET"
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: init.body,
          }),
    })
  }
  const authoring = new SourceAuthoringClient(mappedRequest)
  const message = new MessageFieldHttpClient(mappedRequest)
  return Object.freeze({
    load: (signal?: AbortSignal) =>
      authoring.load(descriptor.registryId, signal),
    save: (base: SourceAuthoringEnvelopeV1, projection: SourceProjection) =>
      authoring.save(descriptor.registryId, base, projection),
    compileLogic: (
      base: SourceAuthoringEnvelopeV1,
      logic: SourceLogicProjectionV1,
    ) => authoring.compile(descriptor.registryId, base, logic),
    validate: (base: SourceAuthoringEnvelopeV1) =>
      authoring.validate(descriptor.registryId, base),
    publish: (base: SourceAuthoringEnvelopeV1) =>
      authoring.publish(descriptor.registryId, base),
    messageFields: (signal?: AbortSignal) =>
      message.surface(descriptor.registryId, signal),
    messageView: (
      input: MessageLiteralViewRequest,
      expectedSourceHash: string,
    ) => message.view(descriptor.registryId, input, expectedSourceHash),
    messageSlot: (write: MessageLiteralWrite) =>
      message.slot(descriptor.registryId, write),
    messageCompile: (edit: MessageFieldEdit) =>
      message.compile(descriptor.registryId, edit),
  })
}

/** Единственный явный browser transport; default factory никогда не выбирает global fetch сама. */
export function createNativeSourceBrowserPort(
  binding: NativeSourceBinding,
): NativeSourceEditorPort {
  return createNativeSourceEditorPort(binding, (input, init) => {
    const request = fetch
    return request(input, init)
  })
}
