// @vitest-environment jsdom
import {
  type AbstractIntlMessages,
  NextIntlClientProvider,
  useTranslations,
} from "next-intl"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import {
  useNativeSourceMessageLabels,
  useNativeSourcePropertyLabels,
} from "../src/features/flows/supacrm-source/native/property-labels"
import { locales } from "../src/i18n/config"
import { messagesByLocale } from "../src/i18n/messages"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
function NativeLabelsProbe() {
  const property = useNativeSourcePropertyLabels()
  const message = useNativeSourceMessageLabels()
  const frame = useTranslations("supacrmNativeSource.frame")
  const card = useTranslations("supacrmNativeSource.card")
  const canvas = useTranslations("supacrmNativeSource.canvas")
  return (
    <div>
      <p data-label="property">{property.description}</p>
      <p data-label="message">{message.save}</p>
      <p data-label="frame">{frame("publish")}</p>
      <p data-label="card">{card("kinds.send_message")}</p>
      <p data-label="canvas">{canvas("addUnavailable")}</p>
      {Object.entries(property).map(([key, text]) => (
        <span key={`property.${key}`}>{text}</span>
      ))}
      {Object.entries(message).map(([key, text]) => (
        <span key={`message.${key}`}>{text}</span>
      ))}
    </div>
  )
}
let root: Root | undefined
let view: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  view?.remove()
})

test.each(
  locales,
)("%s: реальные native переводы работают с сырым каталогом ClientProvider без fallback", async (locale) => {
  view = document.createElement("div")
  document.body.append(view)
  root = createRoot(view)
  await act(() =>
    root?.render(
      <NextIntlClientProvider
        locale={locale}
        messages={messagesByLocale[locale] as AbstractIntlMessages}
        timeZone="UTC"
      >
        <NativeLabelsProbe />
      </NextIntlClientProvider>,
    ),
  )
  const expected =
    locale === "ru"
      ? {
          property: "Настройки блока",
          message: "Скомпилировать сообщение",
          frame: "Опубликовать",
          card: "Сообщение",
          canvas: "Добавление блоков пока недоступно",
        }
      : {
          property: "Block settings",
          message: "Compile message",
          frame: "Publish",
          card: "Message",
          canvas: "Adding blocks is unavailable",
        }
  for (const [key, text] of Object.entries(expected)) {
    expect(view.querySelector(`[data-label="${key}"]`)?.textContent).toBe(text)
  }
  expect(view.textContent).not.toContain("supacrmNativeSource.")
})
