// @vitest-environment node
import { createTranslator } from "next-intl"
import { describe, expect, test } from "vitest"
import english from "../messages/en.json"
import russian from "../messages/ru.json"
import { checkCatalog, russianComparisonSource } from "../scripts/check-i18n"

const oneBranchPattern = /one \{[^}]*\}/

describe("locale-aware catalogue checks", () => {
  test("accepts counted Russian one branches without changing the English source", () => {
    const original = english.messages.sentAttachments
    expect(checkCatalog(english, russian, "ru")).toEqual({
      missingKeys: {},
      invalidKeys: {},
    })
    expect(english.messages.sentAttachments).toBe(original)
  })

  test("Russian one branches display the count for 21", () => {
    const t = createTranslator({ locale: "ru", messages: russian })
    for (const key of [
      "messages.sentAttachments",
      "appointmentCalendars.reminderTimingLabels.hours",
      "appointmentCalendars.reminderTimingLabels.days",
      "workingHours.employeesDialog.clearAllAria",
    ] as const) {
      expect(t(key, { count: 21 }), key).toContain("21")
    }
  })

  test("still rejects a missing Russian key", () => {
    const target = structuredClone(russian)
    Reflect.deleteProperty(target.messages, "sentAttachments")
    expect(
      Object.keys(checkCatalog(english, target, "ru").missingKeys ?? {}),
    ).not.toHaveLength(0)
  })

  test("still requires the numeric placeholder in the Russian one branch", () => {
    const target = structuredClone(russian)
    target.messages.sentAttachments = target.messages.sentAttachments.replace(
      oneBranchPattern,
      "one {вложение}",
    )
    expect(
      Object.keys(checkCatalog(english, target, "ru").invalidKeys ?? {}),
    ).not.toHaveLength(0)
  })

  test("preserves original validation for other languages", () => {
    expect(checkCatalog(english, english, "en")).toEqual({
      missingKeys: {},
      invalidKeys: {},
    })
    expect(
      Object.keys(
        checkCatalog(english, russianComparisonSource(english), "en")
          .invalidKeys ?? {},
      ),
    ).not.toHaveLength(0)
  })

  test("requires explicit review if an English exception branch changes", () => {
    const source = structuredClone(english)
    Reflect.set(source.messages, "sentAttachments", "Updated source")
    expect(() => russianComparisonSource(source)).toThrow(
      "Review Russian plural comparison",
    )
  })
})
