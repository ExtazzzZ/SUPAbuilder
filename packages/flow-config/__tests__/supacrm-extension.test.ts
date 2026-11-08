import { describe, expect, test } from "vitest"
import { supacrmExtensions } from "../src/extensions/supacrm"
import { sendTextStepSchema } from "../src/steps/send-text"

describe("Команды SUPAcrm через подписанный API-канал", () => {
  test("пауза не содержит секретов или выбираемой идентичности клиента", () => {
    const step = supacrmExtensions["supacrm.handoff"].compile({ paused: true })
    expect(sendTextStepSchema.safeParse(step).success).toBe(true)
    expect(step.text).toBe('SUPACRM_ACTION_V1:{"action":"operator.handoff","payload":{"paused":true}}')
    expect(JSON.stringify(step)).not.toMatch(/serviceKey|https:|peerId|botId/)
  })
  test("отвергает старый inline credential контракт", () => {
    expect(() => supacrmExtensions["supacrm.handoff"].inputSchema.parse({
      paused: true, serviceKey: "private-value", crmBaseUrl: "https://crm.invalid",
    })).toThrow()
  })
  test("каталог компилируется без callApi", () => {
    const step = supacrmExtensions["supacrm.catalog"].compile({})
    expect(step.stepType).toBe("sendText")
    expect(step.text).toBe('SUPACRM_ACTION_V1:{"action":"catalog.list","payload":{}}')
  })
})
