import { describe, expect, test } from "vitest"
import { decodeButtonPayload, encodeButtonPayload } from "../src/util"
import { resolveNamedEntry } from "../src/named-entry"

const reminder = (id: string) => ({
  id, type: "sendMessage", data: { name: "Редактируемое название", details: {
    supacrmReminder: { anchor: "customer_confirmed" },
    quickReplies: [{ id: "new-button-id" }],
  } },
})

describe("именованное событие Apple", () => {
  test("переживает пересоздание кнопок и узла", () => {
    const payload = "11::::::::apple.feedback"
    expect(decodeButtonPayload(payload)).toEqual({ flowId: "11", entry: "apple.feedback" })
    expect(encodeButtonPayload({ flowId: "11", entry: "apple.feedback" })).toBe(payload)
    expect(resolveNamedEntry([reminder("new-node")], "apple.feedback")).toBe("new-node")
  })
  test("закрывает неоднозначную и отсутствующую точку входа", () => {
    expect(() => resolveNamedEntry([], "apple.feedback")).toThrow()
    expect(() => resolveNamedEntry([reminder("one"), reminder("two")], "apple.feedback")).toThrow()
    expect(decodeButtonPayload("11::::::::foreign.event")).toBeNull()
    expect(decodeButtonPayload("11::77::::::apple.feedback")).toBeNull()
  })
})
