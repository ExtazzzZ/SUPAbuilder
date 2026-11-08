// @vitest-environment node
import { format } from "date-fns"
import { describe, expect, test } from "vitest"
import { defaultLocale, localeMeta, resolveLocale } from "@/i18n/config"
import { getDirection } from "@/i18n/direction"
import { toDateFnsLocale } from "@/lib/date-fns-locale"

describe("Russian builder locale", () => {
  test("defaults missing and unsupported preferences to Russian", () => {
    expect(defaultLocale).toBe("ru")
    expect(resolveLocale(undefined)).toBe("ru")
    expect(resolveLocale("")).toBe("ru")
    expect(resolveLocale("unsupported")).toBe("ru")
  })

  test.each([
    "ru",
    "ru-RU",
    "RU",
    " ru-KZ ",
  ])("resolves %s to Russian", (preference) => {
    expect(resolveLocale(preference)).toBe("ru")
  })

  test("offers Russian with its native name and left-to-right direction", () => {
    expect(localeMeta).toHaveProperty("ru", {
      nativeLabel: "Русский",
      dir: "ltr",
    })
    expect(getDirection("ru")).toBe("ltr")
  })

  test("formats calendar dates and month names in Russian", () => {
    const locale = toDateFnsLocale("ru")
    expect(format(new Date(2026, 0, 15), "PP", { locale })).toBe(
      "15 янв. 2026 г.",
    )
    expect(format(new Date(2026, 0, 15), "LLLL", { locale })).toBe("январь")
    expect(locale.options?.weekStartsOn).toBe(1)
  })

  test("uses the resolved Russian locale for regional and unknown calendar preferences", () => {
    expect(toDateFnsLocale("ru-RU").code).toBe("ru")
    expect(toDateFnsLocale("unsupported").code).toBe("ru")
  })

  test("preserves an explicitly selected language", () => {
    expect(resolveLocale("en-US")).toBe("en")
    expect(toDateFnsLocale("en").code).toBe("en-US")
    expect(resolveLocale("de")).toBe("de")
    expect(toDateFnsLocale("de").code).toBe("de")
  })
})
