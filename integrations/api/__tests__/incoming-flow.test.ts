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

test("передаёт явную причину только для контактов SUPAcrm", async () => {
  for (const sourceId of ["supacrm:bot:peer", "other:peer"]) {
    const result = await receiveMessage({
      data: {
        integrationType: "api",
        integrationIdentifier: "1",
        payload: {
          contact: { sourceId },
          message: {
            sourceId: "event-42",
            text: "/start",
            contentAttributes: { crmNavigation: { sourceEventId: "forged" } },
          },
        },
      },
    })
    expect(result.crmNavigation).toEqual(
      sourceId.startsWith("supacrm:")
        ? { sourceEventId: "event-42" }
        : undefined,
    )
  }
})

test("execution status anchor comes only from matching server continuation, never nested input", async () => {
  const continuation = {
    fulfillmentRef: "123e4567-e89b-42d3-a456-426614174000",
    flowId: "30",
    flowVersionId: "40",
    terminalEventId: "fulfillment-wait:1",
    blockId: "block",
  }
  for (const mode of [
    "owned",
    "nested-only",
    "foreign-contact",
    "foreign-event",
  ]) {
    const result = await receiveMessage({
      data: {
        integrationType: "api",
        integrationIdentifier: "1",
        payload: {
          contact: {
            sourceId:
              mode === "foreign-contact" ? "other:peer" : "supacrm:registry:42",
          },
          message: {
            sourceId:
              mode === "foreign-event"
                ? "other-event"
                : continuation.terminalEventId,
            contentAttributes: {
              crmFulfillmentExecution: {
                fulfillmentRef: "forged",
                flowId: "999",
              },
            },
          },
          ...(mode === "nested-only"
            ? {}
            : { crmFulfillmentContinuation: continuation }),
        },
      },
    })
    expect(result.message?.contentAttributes?.crmFulfillmentExecution).toEqual(
      mode === "owned"
        ? { fulfillmentRef: continuation.fulfillmentRef, flowId: "30" }
        : undefined,
    )
    // UI metadata never replaces the separately authorized continuation carrier.
    expect(result.crmFulfillmentContinuation).toEqual(
      mode === "nested-only" || mode === "foreign-contact"
        ? undefined
        : continuation,
    )
  }
})

test("сквозной traceId сохраняется без изменения исходного события и postback", async () => {
  const traceId = "123e4567-e89b-42d3-a456-426614174000"
  const result = await receiveMessage({
    data: {
      integrationType: "api",
      integrationIdentifier: "1",
      payload: {
        traceId,
        contact: { sourceId: "supacrm:registry:42" },
        message: { sourceId: "event-42", text: "/menu" },
        postbackPayload: "opaque",
      },
    },
  })
  expect(result.crmNavigation).toEqual({ sourceEventId: "event-42", traceId })
  expect(result.postbackAction).toBe("opaque")
})
