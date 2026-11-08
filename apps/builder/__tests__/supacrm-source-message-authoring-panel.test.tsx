// @vitest-environment jsdom
import type {
  SourceAuthoringEnvelopeV1,
  SourceNode,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { MessageAuthoringPanel } from "../src/features/flows/supacrm-source/message-authoring/message-authoring-panel"
import { MessageFieldHttpClient } from "../src/features/flows/supacrm-source/message-authoring/message-field-http"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock("next-intl", () => ({ useLocale: () => "ru" }))
const pin = "a".repeat(64),
  raw = "b".repeat(64)
const node: SourceNode = {
  sourceId: "b",
  scenarioId: "s",
  kind: "send_message",
  label: "Сообщение",
  content: {},
  bindings: [],
  ports: [],
  position: { x: 0, y: 0 },
}
const target = {
  scenario_id: "s",
  block_id: "b",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
const field = {
  field_id: "f",
  target,
  editable: true,
  code: "ordinary",
  handler_id: "source-presentation/1",
  schema_ref: "source.message.plain-text/1",
  policy_revision: "p1",
  descriptor_version: "d1",
}
const envelope: SourceAuthoringEnvelopeV1 = {
  version: "supacrm.source-authoring.v1",
  source_revision: pin,
  source_hash: raw,
  draft_version: 1,
  projection: {
    version: "supacrm.source-projection.v1",
    sourceRevision: pin,
    nodes: [node],
    edges: [],
    symbols: [],
  },
  diagnostics: [],
  publishable: false,
}
const surface = {
  schema_version: "source-authoring-surface/1" as const,
  source_revision: pin,
  source_hash: raw,
  draft_version: 1,
  fields: [field],
  unsupported_field_ids: [],
  production: false as const,
  publishable: false as const,
}
const view = {
  ...field,
  editable: undefined,
  code: undefined,
  schema_version: "message-field-view/1" as const,
  source_revision: pin,
  source_hash: raw,
  draft_version: 1,
  slot: {
    kind: "literal_slot" as const,
    slot_id: "slot-a",
    declared_type: "str" as const,
  },
  text: "A",
}
const { editable: _editable, code: _code, ...safeView } = view
let root: Root | undefined
let container: HTMLDivElement
const dirty = vi.fn(),
  unknown = vi.fn(),
  compiled = vi.fn()
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  root = undefined
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
function setup() {
  const client = new MessageFieldHttpClient()
  const inventory = vi.spyOn(client, "surface").mockResolvedValue(surface)
  const read = vi.spyOn(client, "view").mockResolvedValue(safeView)
  const slot = vi
    .spyOn(client, "slot")
    .mockImplementation(async (_bot, write) => ({
      ...safeView,
      text: write.text,
      slot: { ...safeView.slot, slot_id: "slot-b" },
    }))
  const next = { ...envelope, draft_version: 2 }
  const compile = vi.spyOn(client, "compile").mockResolvedValue(next)
  return { client, inventory, read, slot, compile, next }
}
async function render(client: MessageFieldHttpClient) {
  if (!root) {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root?.render(
      <MessageAuthoringPanel
        botId="bot"
        client={client}
        envelope={envelope}
        node={node}
        onCompiled={compiled}
        onDirtyChange={dirty}
        onMutationEnd={vi.fn()}
        onMutationStart={() => true}
        onReloadRequested={() => Promise.resolve()}
        onUnknownChange={unknown}
      />,
    ),
  )
}
function textarea() {
  const input = container.querySelector("textarea")
  if (!input) {
    throw new Error("Нет формы")
  }
  return input
}

test("stale surface не запрашивает текст", async () => {
  const f = setup()
  f.inventory.mockResolvedValueOnce({ ...surface, draft_version: 2 })
  await render(f.client)
  expect(f.read).not.toHaveBeenCalled()
  expect(container.querySelector("textarea")).toBeNull()
})

test("read-only surface не выполняет view и не показывает текст", async () => {
  const f = setup()
  f.inventory.mockResolvedValue({
    ...surface,
    fields: [{ ...field, editable: false }],
  })
  await render(f.client)
  expect(f.read).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain("A")
  expect(container.querySelector("textarea")).toBeNull()
})

test("обычный текст проходит slot→compile; rerender не стирает правку и parent получает canonical envelope", async () => {
  const f = setup()
  await render(f.client)
  const text = "<b>буквально</b> {{ marker }}"
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  await render(f.client)
  expect(textarea().value).toBe(text)
  expect(f.read).toHaveBeenCalledTimes(1)
  const save = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Скомпилировать сообщение",
  )
  if (!save) {
    throw new Error("Нет компиляции")
  }
  await act(async () => save.click())
  expect(f.slot.mock.calls[0]?.[1].text).toBe(text)
  expect(f.compile.mock.calls[0]?.[1].template.runs[0]?.slot_id).toBe("slot-b")
  expect(JSON.stringify(f.compile.mock.calls[0]?.[1])).not.toContain(text)
  expect(compiled).toHaveBeenCalledWith(f.next)
})

test("неизвестный handler при editable=true не читает текст", async () => {
  const f = setup()
  f.inventory.mockResolvedValue({
    ...surface,
    fields: [{ ...field, handler_id: "other-owner/1" }],
  })
  await render(f.client)
  expect(f.read).not.toHaveBeenCalled()
  expect(container.querySelector("textarea")).toBeNull()
})
