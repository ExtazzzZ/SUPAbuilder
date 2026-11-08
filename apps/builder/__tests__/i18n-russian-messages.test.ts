// @vitest-environment node
import { createTranslator } from "next-intl"
import { describe, expect, test } from "vitest"
import russian from "../messages/ru.json"

function flatten(messages: Record<string, unknown>, prefix = "") {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") {
      result[path] = value
    } else if (typeof value === "object" && value !== null) {
      Object.assign(result, flatten(value as Record<string, unknown>, path))
    }
  }
  return result
}

describe("Russian builder messages", () => {
  test("formats every message including ICU arguments and rich text without fallback errors", () => {
    const errors: string[] = []
    const t = createTranslator({
      locale: "ru",
      messages: russian,
      onError: (error) => errors.push(error.message),
    })

    for (const [key, message] of Object.entries(flatten(russian))) {
      const values: Record<
        string,
        number | string | ((chunks: unknown) => string)
      > = {}
      for (const match of message.matchAll(/\{([A-Za-z][\w.-]*)(?:\s*[,}])/g)) {
        values[match[1]] = 2
      }
      for (const match of message.matchAll(/<([A-Za-z][\w]*)>/g)) {
        values[match[1]] = (chunks) => String(chunks)
      }
      // Ключи получены из того же типизированного словаря.
      t.rich(key as Parameters<typeof t.rich>[0], values)
    }

    expect(errors).toEqual([])
  })

  test("describes all selected broadcasts when the count ends in one", () => {
    const t = createTranslator({ locale: "ru", messages: russian })
    expect(
      t("broadcasts.deleteDialog.description", { count: 1, name: "Первая" }),
    ).toContain("Первая")
    const bulk = t("broadcasts.deleteDialog.description", {
      count: 21,
      name: "Первая",
    })
    expect(bulk).toContain("21")
    expect(bulk).not.toContain("Первая")
    expect(t("broadcasts.deleteDialog.title", { count: 21 })).toContain(
      "рассылки",
    )
  })

  test.each([
    1, 2, 21,
  ])("renders schedule interval %s without a literal pound", (interval) => {
    const t = createTranslator({ locale: "ru", messages: russian })
    const text = t("recurrence.summary.sentence", {
      interval,
      frequency: "daily",
      weekdays: "пн",
      monthDay: "last",
      time: "09:00",
      timezone: "Asia/Aqtau",
      startsOn: "30 октября",
      endKind: "never",
      endDate: "31 октября",
      endCount: 2,
    })
    expect(text).toContain(`Раз в ${interval}`)
    expect(text).not.toContain("#")
  })
})
