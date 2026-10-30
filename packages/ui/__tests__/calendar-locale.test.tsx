import { enUS } from "date-fns/locale"
import { act } from "react"
import { de, ru } from "react-day-picker/locale"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Calendar } from "../src/components/ui/calendar"
import { CalendarLocaleProvider } from "../src/components/ui/calendar-locale-context"
import { DateTimePicker } from "../src/components/ui/date-picker"

describe("calendar language supplied by the app", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  test("renders Russian month, weekdays and navigation labels", () => {
    act(() => {
      root.render(
        <CalendarLocaleProvider
          value={{ locale: ru, pickDate: "Выберите дату" }}
        >
          <Calendar defaultMonth={new Date(2026, 0, 15)} />
        </CalendarLocaleProvider>,
      )
    })

    expect(container.textContent).toContain("январь")
    expect(container.textContent).toContain("пн")
    expect(
      container.querySelector('[aria-label="Перейти к следующему месяцу"]'),
    ).not.toBeNull()
  })

  test("allows a calendar to override the language supplied by the app", () => {
    act(() => {
      root.render(
        <CalendarLocaleProvider
          value={{ locale: ru, pickDate: "Выберите дату" }}
        >
          <Calendar defaultMonth={new Date(2026, 0, 15)} locale={de} />
        </CalendarLocaleProvider>,
      )
    })

    expect(container.textContent).toContain("Januar")
    expect(container.textContent).not.toContain("январь")
  })

  test("an explicit date-fns locale replaces inherited navigation labels", () => {
    act(() => {
      root.render(
        <CalendarLocaleProvider
          value={{ locale: ru, pickDate: "Выберите дату" }}
        >
          <Calendar defaultMonth={new Date(2026, 0, 15)} locale={enUS} />
        </CalendarLocaleProvider>,
      )
    })

    expect(container.textContent).toContain("January")
    expect(
      container.querySelector('[aria-label="Go to the Next Month"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[aria-label="Перейти к следующему месяцу"]'),
    ).toBeNull()
  })

  test("renders the translated empty date picker placeholder", () => {
    act(() => {
      root.render(
        <CalendarLocaleProvider
          value={{ locale: ru, pickDate: "Выберите дату" }}
        >
          <DateTimePicker granularity="day" />
        </CalendarLocaleProvider>,
      )
    })

    expect(container.textContent).toContain("Выберите дату")
  })

  test("formats the selected date using the app language", () => {
    act(() => {
      root.render(
        <CalendarLocaleProvider
          value={{ locale: ru, pickDate: "Выберите дату" }}
        >
          <DateTimePicker granularity="day" value={new Date(2026, 0, 15)} />
        </CalendarLocaleProvider>,
      )
    })

    expect(container.textContent).toContain("янв")
  })
})
