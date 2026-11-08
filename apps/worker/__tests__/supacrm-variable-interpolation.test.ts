import { expect, test, vi } from "vitest"

const resolve = vi.hoisted(() =>
  vi.fn(async (_contact, value) => ({ ...value, text: "подставленный текст" })),
)
vi.mock("@chatbotx.io/variables", () => ({
  resolveContactVariablesDeep: resolve,
}))

import { resolveAuthoredChannelStep } from "../src/chat/resolve-authored-channel-step"

test("API variable marker preserves JSON literals and reserved placeholder", async () => {
  const step = {
    stepType: "sendText",
    text: 'SUPACRM_ACTION_V1:{"action":"variables.render","payload":{"key":"language","template":"{a|b} {{value}}"}}',
  }
  expect(await resolveAuthoredChannelStep("123", step, "api", {})).toEqual(step)
  expect(resolve).not.toHaveBeenCalled()
})

test("ordinary messages and other channels keep standard interpolation", async () => {
  const step = { stepType: "sendText", text: "Привет {{name}}" }
  expect((await resolveAuthoredChannelStep("123", step, "api", {})).text).toBe(
    "подставленный текст",
  )
  expect(
    (await resolveAuthoredChannelStep("123", step, "telegram", {})).text,
  ).toBe("подставленный текст")
  expect(resolve).toHaveBeenCalledTimes(2)
})

test.each([
  'SUPACRM_ACTION_V1:{"action":"variables.set","payload":{"key":"language","confirmation":"Готово","value":null}}',
  'SUPACRM_ACTION_V1:{"action":"variables.set","payload":{"key":"language","confirmation":"Готово","value_from":"inbound_text"}}',
])("autoCAS и inbound marker обходят обычную interpolation: %s", async (text) => {
  const calls = resolve.mock.calls.length
  const step = { stepType: "sendText", text }
  expect(await resolveAuthoredChannelStep("123", step, "api", {})).toEqual(step)
  expect(resolve).toHaveBeenCalledTimes(calls)
})
