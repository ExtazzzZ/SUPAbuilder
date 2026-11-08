// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import {
  MessageFieldController,
  type MessageFieldControllerProps,
} from "../src/features/flows/supacrm-source/message-authoring/message-field-controller"
import {
  type MessageAuthoringPort,
  MessageAuthoringRejected,
  type MessageFieldScope,
  type MessageSurfaceField,
} from "../src/features/flows/supacrm-source/message-authoring/port"
import type { MessageLiteralView } from "../src/features/flows/supacrm-source/message-authoring/wire"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const span = {
  scenario_id: "s",
  block_id: "b",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
const scope: MessageFieldScope = {
  fieldId: "field",
  sourceKind: "send_message",
  target: span,
  fullPin: { sourceRevision: "ir1", sourceHash: "hash1", draftVersion: 1 },
}
const field: MessageSurfaceField = {
  field_id: "field",
  target: span,
  editable: true,
  code: "registered_owner_proposal_only",
  handler_id: "source-presentation/1",
  policy_revision: "policy1",
  descriptor_version: "descriptor1",
  schema_ref: "source.message.plain-text/1",
}
const view: MessageLiteralView = {
  schema_version: "message-field-view/1",
  field_id: "field",
  target: span,
  source_revision: "ir1",
  source_hash: "hash1",
  draft_version: 1,
  handler_id: "source-presentation/1",
  policy_revision: "policy1",
  descriptor_version: "descriptor1",
  schema_ref: "source.message.plain-text/1",
  slot: { kind: "literal_slot", slot_id: "old-slot", declared_type: "str" },
  text: "A",
}
const labels = {
  save: "Сохранить",
  saving: "Сохранение",
  saveError: "Черновик сохранён",
  readOnly: "Недоступно",
  reload: "Перезагрузить",
  loading: "Загрузка",
  unknown: "Результат неизвестен, перезагрузите",
}
function fixture() {
  return {
    readField: vi.fn().mockResolvedValue({ field, view }),
    writeLiteral: vi.fn().mockImplementation(async (write) => ({
      ...view,
      draft_version: 1,
      text: write.text,
      slot: {
        kind: "literal_slot",
        slot_id: "new-slot",
        declared_type: "str",
      },
    })),
    compileField: vi.fn().mockResolvedValue({
      sourceRevision: "ir2",
      sourceHash: "hash2",
      draftVersion: 2,
    }),
  } satisfies MessageAuthoringPort
}
let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})
async function render(
  port = fixture(),
  strict = false,
  callbacks: Partial<MessageFieldControllerProps> = {},
) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const onCompiled = vi.fn()
  const onReloadRequested = vi.fn().mockResolvedValue(undefined)
  const component = (
    <MessageFieldController
      label="Сообщение"
      labels={labels}
      onCompiled={onCompiled}
      onReloadRequested={onReloadRequested}
      port={port}
      scope={scope}
      {...callbacks}
    />
  )
  await act(async () =>
    root?.render(strict ? <StrictMode>{component}</StrictMode> : component),
  )
  return { port, onCompiled, onReloadRequested }
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.getAttribute("aria-label") === label,
  )
  if (!found) {
    throw new Error(`Нет кнопки ${label}`)
  }
  return found
}
function textarea() {
  const found = container.querySelector("textarea")
  if (!found) {
    throw new Error("Нет текстового поля")
  }
  return found
}
async function type(text: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function save() {
  await act(() => button(labels.save).click())
}

test("A→B проходит literal grant→typed compile с authoritative CAS и новым pin без fetch", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const { port, onCompiled } = await render()
  expect(textarea().value).toBe("A")
  await type("B")
  expect(port.writeLiteral).not.toHaveBeenCalled()
  await save()
  expect(port.writeLiteral).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      text: "B",
      field_id: "field",
      target: span,
      expected_full_ir_id: "ir1",
      expected_source_hash: "hash1",
      expected_draft_version: 1,
    }),
  )
  expect(port.compileField).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      expected_draft_version: 1,
      template: {
        context: "text",
        runs: [
          { kind: "literal_slot", slot_id: "new-slot", declared_type: "str" },
        ],
      },
    }),
  )
  expect(JSON.stringify(port.compileField.mock.calls)).not.toContain(
    '"text":"B"',
  )
  expect(onCompiled).toHaveBeenCalledExactlyOnceWith({
    sourceRevision: "ir2",
    sourceHash: "hash2",
    draftVersion: 2,
  })
  expect(fetch).not.toHaveBeenCalled()
})

test.each([
  "secret",
  "protected",
  "unresolved",
  "wrong_handler",
  "wrong_field",
  "wrong_span",
  "wrong_pin",
  "wrong_draft",
  "non_string_slot",
])("safe surface classification %s не показывает текст и не разрешает commit", async (classification) => {
  const port = fixture()
  const next = structuredClone({ field, view })
  next.view.text = "DO_NOT_REVEAL"
  if (["secret", "protected", "unresolved"].includes(classification)) {
    next.field.editable = false
    next.field.code = classification
  }
  if (classification === "wrong_handler") {
    next.field.handler_id = "other"
  }
  if (classification === "wrong_field") {
    next.view.field_id = "other"
  }
  if (classification === "wrong_span") {
    next.field.target.path = "params.other"
  }
  if (classification === "wrong_pin") {
    next.view.source_hash = "other"
  }
  if (classification === "wrong_draft") {
    next.view.draft_version = 2
  }
  if (classification === "non_string_slot") {
    next.view.slot.declared_type = "num"
  }
  port.readField.mockResolvedValue(next)
  await render(port)
  expect(container.querySelector("textarea,input")).toBeNull()
  expect(container.innerHTML).not.toContain("DO_NOT_REVEAL")
  expect(port.writeLiteral).not.toHaveBeenCalled()
  expect(port.compileField).not.toHaveBeenCalled()
})

test.each([
  "validation_rejected",
  "conflict",
] as const)("подтверждённый отказ %s сохраняет B и позволяет новое явное сохранение", async (code) => {
  const port = fixture()
  port.writeLiteral.mockRejectedValueOnce(new MessageAuthoringRejected(code))
  await render(port)
  await type("B")
  await save()
  expect(textarea().value).toBe("B")
  expect(button(labels.save).disabled).toBe(false)
  expect(port.writeLiteral).toHaveBeenCalledTimes(1)
  await save()
  expect(port.writeLiteral).toHaveBeenCalledTimes(2)
  expect(port.compileField).toHaveBeenCalledTimes(1)
})

test("unknown сохраняет B и Reload запрашивает родительский canonical refresh без чтения старого pin", async () => {
  const port = fixture()
  port.writeLiteral.mockRejectedValueOnce(new Error("PRIVATE_DETAILS"))
  const { onReloadRequested } = await render(port)
  await type("B")
  await save()
  expect(textarea().value).toBe("B")
  expect(button(labels.save).disabled).toBe(true)
  expect(container.textContent).not.toContain("PRIVATE_DETAILS")
  await save()
  expect(port.writeLiteral).toHaveBeenCalledTimes(1)
  await act(() => button(labels.reload).click())
  expect(onReloadRequested).toHaveBeenCalledTimes(1)
  expect(port.readField).toHaveBeenCalledTimes(1)
  expect(button(labels.save).disabled).toBe(true)
})

test("потеря ответа compile сохраняет B и запрещает новый slot до Reload", async () => {
  const port = fixture()
  port.compileField.mockRejectedValueOnce(new Error("unknown"))
  await render(port)
  await type("B")
  await save()
  expect(textarea().value).toBe("B")
  expect(button(labels.save).disabled).toBe(true)
  await save()
  expect(port.writeLiteral).toHaveBeenCalledTimes(1)
})

test("marker text остаётся обычным literal и двойной click создаёт только один grant", async () => {
  const { port } = await render()
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Проверяем буквальный текст, а не исполнение шаблона.
  const marker = "{{secret}} <script>alert(1)</script> ${process.env.TOKEN}"
  await type(marker)
  await act(() => {
    button(labels.save).click()
    button(labels.save).click()
  })
  expect(port.writeLiteral).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: marker }),
  )
  expect(port.compileField).toHaveBeenCalledTimes(1)
  expect(container.querySelector("script")).toBeNull()
})

test("неверный grant policy/span/pin не достигает compile", async () => {
  const port = fixture()
  port.writeLiteral.mockResolvedValue({
    ...view,
    text: "B",
    policy_revision: "other",
    draft_version: 1,
  })
  const { onCompiled } = await render(port)
  await type("B")
  await save()
  expect(port.compileField).not.toHaveBeenCalled()
  expect(onCompiled).not.toHaveBeenCalled()
  expect(button(labels.save).disabled).toBe(true)
})

test("StrictMode не оставляет чтение в бесконечном pending", async () => {
  await render(fixture(), true)
  expect(textarea().value).toBe("A")
  expect(button(labels.save).disabled).toBe(false)
})

test("подтверждённый 422 compile сохраняет B и следующий grant использует CAS предыдущего ответа", async () => {
  const port = fixture()
  port.compileField.mockRejectedValueOnce(
    new MessageAuthoringRejected("validation_rejected"),
  )
  await render(port)
  await type("B")
  await save()
  expect(textarea().value).toBe("B")
  expect(button(labels.save).disabled).toBe(false)
  await save()
  expect(port.writeLiteral.mock.calls[1]?.[0].expected_draft_version).toBe(1)
  expect(port.compileField).toHaveBeenCalledTimes(2)
})

test.each([
  "field",
  "span",
  "pin",
  "slot_type",
  "cas",
  "cas_higher",
])("grant с неверным %s блокирует compile и повторы", async (mismatch) => {
  const port = fixture()
  const grant = structuredClone({ ...view, text: "B", draft_version: 1 })
  if (mismatch === "field") {
    grant.field_id = "other"
  }
  if (mismatch === "span") {
    grant.target.block_id = "other"
  }
  if (mismatch === "pin") {
    grant.source_revision = "ir-other"
  }
  if (mismatch === "slot_type") {
    grant.slot.declared_type = "num"
  }
  if (mismatch === "cas") {
    grant.draft_version = 0
  }
  if (mismatch === "cas_higher") {
    grant.draft_version = 2
  }
  port.writeLiteral.mockResolvedValue(grant)
  await render(port)
  await type("B")
  await save()
  expect(port.compileField).not.toHaveBeenCalled()
  expect(button(labels.save).disabled).toBe(true)
})

test("смена поля во время grant не запускает compile старого поля", async () => {
  const port = fixture()
  let finish: ((value: MessageLiteralView) => void) | undefined
  port.writeLiteral.mockImplementationOnce(
    () =>
      new Promise<MessageLiteralView>((resolve) => {
        finish = resolve
      }),
  )
  const { onCompiled } = await render(port)
  await type("B")
  await act(() => button(labels.save).click())
  await act(() =>
    root?.render(
      <MessageFieldController
        label="Другое поле"
        labels={labels}
        onCompiled={onCompiled}
        onReloadRequested={async () => undefined}
        port={port}
        scope={{ ...scope, fieldId: "different" }}
      />,
    ),
  )
  await act(async () => finish?.({ ...view, text: "B", draft_version: 1 }))
  expect(port.compileField).not.toHaveBeenCalled()
  expect(onCompiled).not.toHaveBeenCalled()
})

test("клиентский лимит Unicode не отправляет неподдерживаемый текст на порт", async () => {
  const { port } = await render()
  await type("😀".repeat(16_385))
  await save()
  expect(port.writeLiteral).not.toHaveBeenCalled()
  expect(textarea().value).toBe("😀".repeat(16_385))
  expect(button(labels.save).disabled).toBe(false)
})

test("потерянный ответ уже committed compile восстанавливается только parent reload с новым scope", async () => {
  const port = fixture()
  port.compileField.mockRejectedValueOnce(new Error("lost_after_commit"))
  const newScope: MessageFieldScope = {
    ...scope,
    fullPin: { sourceRevision: "ir2", sourceHash: "hash2", draftVersion: 2 },
  }
  const confirmedView = {
    ...view,
    source_revision: "ir2",
    source_hash: "hash2",
    draft_version: 2,
    text: "B",
  }
  const refreshedPort = fixture()
  refreshedPort.readField.mockResolvedValue({ field, view: confirmedView })
  refreshedPort.writeLiteral.mockImplementation(async (write) => ({
    ...confirmedView,
    text: write.text,
    slot: { kind: "literal_slot", slot_id: "newer-slot", declared_type: "str" },
  }))
  refreshedPort.compileField.mockResolvedValue({
    sourceRevision: "ir3",
    sourceHash: "hash3",
    draftVersion: 3,
  })
  const onCompiled = vi.fn()
  const onReloadRequested = vi.fn(() => {
    root?.render(
      <MessageFieldController
        label="Сообщение"
        labels={labels}
        onCompiled={onCompiled}
        onReloadRequested={async () => undefined}
        port={refreshedPort}
        scope={newScope}
      />,
    )
    return Promise.resolve()
  })
  await render(port, false, { onReloadRequested, onCompiled })
  await type("B")
  await save()
  expect(textarea().value).toBe("B")
  expect(button(labels.save).disabled).toBe(true)
  await act(() => button(labels.reload).click())
  expect(onReloadRequested).toHaveBeenCalledTimes(1)
  expect(port.readField).toHaveBeenCalledTimes(1)
  expect(refreshedPort.readField).toHaveBeenCalledExactlyOnceWith(
    "field",
    newScope.fullPin,
  )
  expect(button(labels.save).disabled).toBe(false)
  await type("C")
  await save()
  expect(refreshedPort.writeLiteral).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      expected_full_ir_id: "ir2",
      expected_source_hash: "hash2",
      expected_draft_version: 2,
      text: "C",
    }),
  )
  expect(onCompiled).toHaveBeenCalledExactlyOnceWith({
    sourceRevision: "ir3",
    sourceHash: "hash3",
    draftVersion: 3,
  })
})

test("shared lock отказывает без запросов, dirty и unknown callbacks сохраняют согласованное состояние", async () => {
  const port = fixture()
  const onMutationStart = vi.fn().mockReturnValue(false)
  const onMutationEnd = vi.fn()
  const onDirtyChange = vi.fn()
  const onUnknownChange = vi.fn()
  await render(port, false, {
    onMutationStart,
    onMutationEnd,
    onDirtyChange,
    onUnknownChange,
  })
  await type("B")
  await save()
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect(onMutationStart).toHaveBeenCalledTimes(1)
  expect(onMutationEnd).not.toHaveBeenCalled()
  expect(port.writeLiteral).not.toHaveBeenCalled()
  onMutationStart.mockReturnValue(true)
  port.compileField.mockRejectedValueOnce(new Error("unknown"))
  await save()
  expect(onMutationEnd).toHaveBeenCalledTimes(1)
  expect(onUnknownChange).toHaveBeenLastCalledWith(true)
  expect(textarea().value).toBe("B")
})

test.each([
  1, 3,
])("compile CAS %s отклоняется: требуется ровно base+1", async (draftVersion) => {
  const port = fixture()
  port.compileField.mockResolvedValue({
    sourceRevision: "ir2",
    sourceHash: "hash2",
    draftVersion,
  })
  const { onCompiled } = await render(port)
  await type("B")
  await save()
  expect(onCompiled).not.toHaveBeenCalled()
  expect(button(labels.save).disabled).toBe(true)
})

test("noop compile с теми же full IR и hash принимается при CAS base+1", async () => {
  const port = fixture()
  port.compileField.mockResolvedValue({
    sourceRevision: "ir1",
    sourceHash: "hash1",
    draftVersion: 2,
  })
  const { onCompiled } = await render(port)
  await type("A")
  await save()
  expect(onCompiled).toHaveBeenCalledExactlyOnceWith({
    sourceRevision: "ir1",
    sourceHash: "hash1",
    draftVersion: 2,
  })
})

test("контроллер допускает native form и native Reload без изменения CAS и unknown поведения", async () => {
  const Form = (
    properties: import("../src/features/flows/supacrm-source/message-authoring/ordinary-message-form").OrdinaryMessageFormProps,
  ) => <div data-native-injected="form">{properties.text}</div>
  await render(fixture(), false, {
    formComponent: Form,
    renderReload: ({ label, disabled, onClick }) => (
      <button
        data-native-injected="reload"
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {label}
      </button>
    ),
  })
  expect(
    container.querySelector('[data-native-injected="form"]')?.textContent,
  ).toBe("A")
  expect(
    container.querySelector('[data-native-injected="reload"]'),
  ).not.toBeNull()
  expect(container.querySelector("textarea")).toBeNull()
})
