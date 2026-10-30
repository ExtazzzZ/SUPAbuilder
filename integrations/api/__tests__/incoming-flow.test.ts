import { expect, test } from "vitest"
import {
  incomingApiMessageSchema,
  receiveMessage,
} from "../src/handlers/message/incoming-message"

test("API entry flow survives inbound parsing and opaque postback stays unchanged", async () => {
  const payload = {
    flowId: "123",
    contact: { sourceId: "crm:bot:peer" },
    message: { sourceId: "event-1", text: "/start" },
    postbackPayload: "opaque-payload",
  }
  const result = await receiveMessage({
    data: { integrationType: "api", integrationIdentifier: "1", payload },
  })
  expect(result.entryFlowId).toBe("123")
  expect(result.postbackAction).toBe("opaque-payload")
  expect(
    incomingApiMessageSchema.safeParse({ ...payload, flowId: "wrong" }).success,
  ).toBe(false)
})
