import { expect, test } from "vitest"
import {
  resolveIncomingTextRouting,
  selectApiEntryFlow,
} from "../src/integration/routing"

test("mapped flow starts only for new contacts or explicit /start", () => {
  const input = {
    integrationType: "api",
    isNewContact: false,
    entryFlowId: "123",
    text: "answer",
  }
  expect(selectApiEntryFlow(input)).toBeUndefined()
  expect(selectApiEntryFlow({ ...input, text: "/start" })).toBe("123")
  expect(selectApiEntryFlow({ ...input, text: "/start referral" })).toBe("123")
  expect(selectApiEntryFlow({ ...input, text: "/starting" })).toBeUndefined()
  expect(selectApiEntryFlow({ ...input, isNewContact: true })).toBe("123")
  expect(
    selectApiEntryFlow({
      ...input,
      integrationType: "telegram",
      isNewContact: true,
    }),
  ).toBeUndefined()
})

test("existing pending input and human ownership keep priority over entry", async () => {
  const conversation = {
    additionalAttributes: { challenge: { nodeId: "pending" } },
  } as never
  const input = {
    conversation,
    hasActionableInput: true,
    hasText: true,
    isConversationActive: async () => true,
  }
  expect((await resolveIncomingTextRouting(input)).type).toBe("challenge")
  expect(
    (
      await resolveIncomingTextRouting({
        ...input,
        isConversationActive: async () => false,
      })
    ).type,
  ).toBe("none")
  expect(
    (await resolveIncomingTextRouting({ ...input, hasActionableInput: false }))
      .type,
  ).toBe("none")
})
