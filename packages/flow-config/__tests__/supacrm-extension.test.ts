import { describe, expect, test } from "vitest"
import { supacrmExtensions } from "../src/extensions/supacrm"
import { externalRequestStepSchema } from "../src/steps/external-request"

const input = {
  crmBaseUrl: "https://crm.example.com",
  serviceKey: "test-service-key",
  botId: "550e8400-e29b-41d4-a716-446655440000",
  peerId: "42",
}
describe("SUPAcrm extension registry", () => {
  test("compiles handoff/resume into editable publishable HTTP blocks", () => {
    const step = supacrmExtensions["supacrm.handoff"].compile(input)
    expect(externalRequestStepSchema.safeParse(step).success).toBe(true)
    expect(step.url).toBe(
      "https://crm.example.com/api/v1/automation/actions/handoff",
    )
    expect(step.body).toEqual({
      bodyType: "json",
      jsonBody: JSON.stringify({
        bot_id: input.botId,
        peer_id: "42",
        paused: true,
      }),
    })
    expect(
      supacrmExtensions["supacrm.handoff"].compile({ ...input, paused: false })
        .body,
    ).toEqual({
      bodyType: "json",
      jsonBody: JSON.stringify({
        bot_id: input.botId,
        peer_id: "42",
        paused: false,
      }),
    })
  })
  test("rejects malformed identity, insecure URL and embedded credentials", () => {
    for (const bad of [
      { botId: "42" },
      { crmBaseUrl: "http://crm.example.com" },
      { crmBaseUrl: "https://user:password@crm.example.com" },
    ]) {
      expect(() =>
        supacrmExtensions["supacrm.handoff"].compile({ ...input, ...bad }),
      ).toThrow()
    }
  })
})
