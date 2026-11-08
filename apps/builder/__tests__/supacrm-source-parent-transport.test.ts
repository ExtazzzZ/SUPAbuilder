// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import {
  createParentAuthoringFetch,
  SOURCE_AUTHORING_BRIDGE_PROTOCOL,
  validateCrmOrigin,
} from "../src/features/flows/supacrm-source/parent-transport"

const origin = "https://crm.example.test"
const path =
  "/api/automation/bots/11111111-1111-4111-8111-111111111111/source-runtime/projection"
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function parentWindow() {
  const postMessage = vi.fn()
  const parent = { postMessage } as unknown as Window
  vi.spyOn(window, "parent", "get").mockReturnValue(parent)
  return { parent, postMessage }
}

test("принимает только response от точного parent/origin/request ID", async () => {
  const { parent, postMessage } = parentWindow()
  const fetch = createParentAuthoringFetch(origin)
  const pending = fetch(path, { method: "GET" })
  const sent = postMessage.mock.calls[0]?.[0]
  expect(postMessage.mock.calls[0]?.[1]).toBe(origin)
  expect(sent).toMatchObject({
    protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
    action: "load",
  })
  expect(sent).not.toHaveProperty("url")
  const body = { synthetic: true }
  for (const wrong of [
    { origin: "https://other.test", source: parent },
    { origin, source: window },
    { origin, source: parent, requestId: "other" },
  ]) {
    window.dispatchEvent(
      new MessageEvent("message", {
        ...wrong,
        data: {
          protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
          requestId: sent.requestId,
          status: 200,
          body,
          ...(wrong.requestId ? { requestId: wrong.requestId } : {}),
        },
      }),
    )
  }
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: parent,
      data: {
        protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
        requestId: sent.requestId,
        status: 200,
        body,
      },
    }),
  )
  expect(await (await pending).json()).toEqual(body)
})

test("timeout сохранения не повторяет сообщение", async () => {
  vi.useFakeTimers()
  const { postMessage } = parentWindow()
  const pending = createParentAuthoringFetch(origin, 100)(
    path.replace("projection", "draft"),
    { method: "PATCH", body: JSON.stringify({ synthetic: true }) },
  )
  const assertion = expect(pending).rejects.toThrow("не подтверждён")
  await vi.advanceTimersByTimeAsync(100)
  await assertion
  expect(postMessage).toHaveBeenCalledTimes(1)
})

test.each([
  "*",
  "null",
  "https://crm.example.test/path",
  "https://user:pass@crm.example.test",
  "data:text/plain,x",
  "https://crm.example.test/",
])("отвергает origin %s", (value) => {
  expect(() => validateCrmOrigin(value)).toThrow()
})

test("отменяет load и не отправляет произвольные URL", async () => {
  const { postMessage } = parentWindow()
  const request = createParentAuthoringFetch(origin)
  await expect(
    request("https://external.test", { method: "GET" }),
  ).rejects.toThrow()
  const abort = new AbortController()
  abort.abort()
  await expect(
    request(path, { method: "GET", signal: abort.signal }),
  ).rejects.toThrow()
  expect(postMessage).not.toHaveBeenCalled()
})

test.each([
  101, 204, 205, 304,
])("не зависает на response status %s с JSON body", async (status) => {
  const { parent, postMessage } = parentWindow()
  const pending = createParentAuthoringFetch(origin)(path, { method: "GET" })
  const sent = postMessage.mock.calls[0]?.[0]
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: parent,
      data: {
        protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
        requestId: sent.requestId,
        status,
        body: {},
      },
    }),
  )
  await expect(pending).rejects.toThrow("Неверный ответ CRM")
})

test.each([
  "compile",
  "validate",
  "publish",
])("%s передаётся parent только как bound action без URL", async (action) => {
  const { parent, postMessage } = parentWindow()
  const pending = createParentAuthoringFetch(origin)(
    path.replace("projection", action),
    { method: "POST", body: JSON.stringify({ synthetic: true }) },
  )
  const sent = postMessage.mock.calls[0]?.[0]
  expect(sent.action).toBe(action)
  expect(sent).not.toHaveProperty("url")
  expect(sent.body).toEqual({ synthetic: true })
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: parent,
      data: {
        protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
        requestId: sent.requestId,
        status: 200,
        body: {},
      },
    }),
  )
  expect((await pending).status).toBe(200)
})

test.each([
  ["message-fields", "GET", "message-fields"],
  ["message-fields/view", "POST", "message-view"],
  ["message-fields/slot", "POST", "message-slot"],
  ["message-fields/compile", "POST", "message-compile"],
])("E1 %s использует только fixed bound action", async (suffix, method, action) => {
  const { parent, postMessage } = parentWindow()
  const pending = createParentAuthoringFetch(origin)(
    path.replace("projection", suffix),
    {
      method,
      ...(method === "POST" ? { body: JSON.stringify({ field_id: "f" }) } : {}),
    },
  )
  const sent = postMessage.mock.calls[0]?.[0]
  expect(sent.action).toBe(action)
  expect(sent).not.toHaveProperty("url")
  expect(sent).not.toHaveProperty("botId")
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: parent,
      data: {
        protocol: SOURCE_AUTHORING_BRIDGE_PROTOCOL,
        requestId: sent.requestId,
        status: 200,
        body: {},
      },
    }),
  )
  expect((await pending).status).toBe(200)
})

test.each([
  ["message-fields", "POST"],
  ["message-fields/view", "GET"],
  ["message-fields/slot", "PATCH"],
  ["message-fields/compile", "GET"],
  ["message-fields/view/other", "POST"],
  ["message-fields?bot=other", "GET"],
])("E1 запрещает другую method/path %s %s", async (suffix, method) => {
  const { postMessage } = parentWindow()
  await expect(
    createParentAuthoringFetch(origin)(path.replace("projection", suffix), {
      method,
      body: JSON.stringify({ field_id: "f" }),
    }),
  ).rejects.toThrow()
  expect(postMessage).not.toHaveBeenCalled()
})
