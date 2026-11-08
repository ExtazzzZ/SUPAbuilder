const en = {
  title: "Message text",
  loading: "Loading message fields…",
  unavailable: "Message fields are unavailable. Reload the server version.",
  save: "Compile message",
  saving: "Compiling…",
  saveError: "The message was not confirmed. Your text is retained.",
  readOnly: "This field is read-only.",
  reload: "Reload server version",
  unknown:
    "The result is unknown. Reload the server version before editing again.",
}
const ru: typeof en = {
  title: "Текст сообщения",
  loading: "Загрузка полей сообщения…",
  unavailable: "Поля сообщения недоступны. Загрузите серверную версию.",
  save: "Скомпилировать сообщение",
  saving: "Компиляция…",
  saveError: "Изменение сообщения не подтверждено. Ваш текст сохранён в форме.",
  readOnly: "Поле доступно только для чтения.",
  reload: "Загрузить серверную версию",
  unknown:
    "Результат неизвестен. Перед следующей правкой загрузите серверную версию.",
}
/** Явный английский fallback для локалей без E1 перевода. */
export const messageAuthoringLabels = (locale: string): typeof en =>
  locale.toLowerCase().startsWith("ru") ? ru : en
