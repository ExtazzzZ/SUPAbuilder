// @vitest-environment jsdom
import type {
  SourceAuthoringEnvelopeV1,
  SourceProjection,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ConnectedSupacrmSourceEditor } from "../src/features/flows/supacrm-source/connected-editor"
import type { MessageFieldHttpClient } from "../src/features/flows/supacrm-source/message-authoring/message-field-http"
import {
  SourceAuthoringClient,
  SourceAuthoringError,
} from "../src/features/flows/supacrm-source/source-client"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock(
  "../src/features/flows/supacrm-source/message-authoring/message-authoring-panel",
  () => ({
    MessageAuthoringPanel: (props: {
      node: { sourceId: string }
      onDirtyChange: (dirty: boolean) => void
      onUnknownChange: (unknown: boolean) => void
      onMutationStart: () => boolean
      onMutationEnd: () => void
      onReloadRequested: () => Promise<void>
    }) => (
      <div data-message-source={props.node.sourceId}>
        <button
          data-action="message-dirty"
          onClick={() => props.onDirtyChange(true)}
          type="button"
        >
          message-dirty
        </button>
        <button
          data-action="message-unknown"
          onClick={() => {
            if (props.onMutationStart()) {
              props.onUnknownChange(true)
              props.onMutationEnd()
            }
          }}
          type="button"
        >
          message-unknown
        </button>
        <button
          data-action="message-reload"
          onClick={() => props.onReloadRequested()}
          type="button"
        >
          message-reload
        </button>
      </div>
    ),
  }),
)
vi.mock("../src/features/flows/supacrm-source/source-editor", () => ({
  SupacrmSourceEditor: ({
    projection,
    onChange,
  }: {
    projection: SourceProjection
    onChange: (projection: SourceProjection) => void
  }) => (
    <input
      aria-label="label"
      onChange={(event) =>
        onChange({
          ...projection,
          nodes: projection.nodes.map((node) => ({
            ...node,
            label: event.target.value,
          })),
        })
      }
      value={projection.nodes[0]?.label ?? ""}
    />
  ),
}))
vi.mock("../src/features/flows/supacrm-source/source-graph", () => ({
  SupacrmSourceGraph: ({
    projection,
    onChange,
    onSelectSource,
  }: {
    projection: SourceProjection
    onChange: (projection: SourceProjection) => void
    onSelectSource: (id: string) => void
  }) => (
    <div>
      <button
        data-action="graph-drag"
        onClick={() =>
          onChange({
            ...projection,
            nodes: projection.nodes.map((node) => ({
              ...node,
              position: { x: 10, y: 20 },
            })),
          })
        }
        type="button"
      >
        graph-drag
      </button>
      <button
        data-action="graph-select"
        onClick={() => onSelectSource(projection.nodes.at(-1)?.sourceId ?? "")}
        type="button"
      >
        graph-select
      </button>
    </div>
  ),
}))
const fixture = (): SourceAuthoringEnvelopeV1 => ({
  version: "supacrm.source-authoring.v1",
  draft_version: 2,
  source_revision: "synthetic",
  projection: {
    version: "supacrm.source-projection.v1",
    sourceRevision: "synthetic",
    nodes: [
      {
        sourceId: "node",
        scenarioId: "scenario",
        kind: "send_message",
        label: "До правки",
        content: {},
        bindings: [],
        ports: [],
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    symbols: [],
  },
  diagnostics: [{ code: "parity_pending", block_id: "node" }],
  publishable: false,
})
function required<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("Нет элемента проверки")
  }
  return value
}
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
})
const render = async (
  client: SourceAuthoringClient,
  messageClient?: MessageFieldHttpClient,
) => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <ConnectedSupacrmSourceEditor
        botId="synthetic-bot"
        client={client}
        messageClient={messageClient}
      />,
    )
    await Promise.resolve()
  })
  return container
}
const edit = async (view: HTMLElement) => {
  const input = required(view.querySelector("input"))
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Мой черновик")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return input
}
const saveButton = (view: HTMLElement) =>
  required(view.querySelector<HTMLButtonElement>('[data-action="save-draft"]'))

test("CAS conflict сохраняет локальный черновик и запрещает автоматический повтор", async () => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockResolvedValue(fixture())
  const save = vi
    .spyOn(client, "save")
    .mockRejectedValue(new SourceAuthoringError("conflict"))
  const view = await render(client)
  expect(view.textContent).toContain("parity_pending")
  const input = await edit(view)
  await act(async () => {
    saveButton(view).click()
    await Promise.resolve()
  })
  expect(input.value).toBe("Мой черновик")
  expect(view.textContent).toContain("errors.conflict")
  expect(saveButton(view).disabled).toBe(true)
  await act(() => saveButton(view).click())
  expect(save).toHaveBeenCalledTimes(1)
})

test("pending save выполняется единожды и не прерывается AbortSignal", async () => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockResolvedValue(fixture())
  let finish: ((envelope: SourceAuthoringEnvelopeV1) => void) | undefined
  const save = vi.spyOn(client, "save").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const view = await render(client)
  await edit(view)
  await act(() => {
    saveButton(view).click()
    saveButton(view).click()
  })
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]).toHaveLength(3)
  expect(saveButton(view).disabled).toBe(true)
  const next = fixture()
  next.draft_version = 3
  next.projection.nodes[0] = {
    ...required(next.projection.nodes[0]),
    label: "Мой черновик",
  }
  await act(async () => {
    required(finish)(next)
    await Promise.resolve()
  })
  expect(view.textContent).toContain("draftSaved")
  expect(saveButton(view).disabled).toBe(true)
})

test("unmount отменяет только загрузку и игнорирует поздний ответ", async () => {
  const client = new SourceAuthoringClient()
  let signal: AbortSignal | undefined
  const load = vi.spyOn(client, "load").mockImplementation((_bot, provided) => {
    signal = provided
    return new Promise(() => {
      /* Загрузка намеренно не завершается до unmount. */
    })
  })
  await render(client)
  expect(load).toHaveBeenCalledTimes(1)
  expect(signal?.aborted).toBe(false)
  await act(() => root?.unmount())
  root = undefined
  expect(signal?.aborted).toBe(true)
})

test("неподтверждённое сохранение удерживает правки до явной сверки", async () => {
  const client = new SourceAuthoringClient()
  const load = vi.spyOn(client, "load").mockResolvedValue(fixture())
  const save = vi
    .spyOn(client, "save")
    .mockRejectedValue(new SourceAuthoringError("save_unconfirmed"))
  const view = await render(client)
  const input = await edit(view)
  await act(async () => {
    saveButton(view).click()
    await Promise.resolve()
  })
  expect(input.value).toBe("Мой черновик")
  expect(view.textContent).toContain("errors.save_unconfirmed")
  expect(load).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  const reload = required(
    Array.from(view.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "reload",
    ),
  )
  await act(async () => {
    reload.click()
    await Promise.resolve()
  })
  expect(load).toHaveBeenCalledTimes(2)
  expect(required(view.querySelector("input")).value).toBe("До правки")
})

test.each([
  new SourceAuthoringError("unauthorized"),
  new Error("synthetic error"),
])("ошибка загрузки показывает безопасную причину и допускает явную сверку", async (cause) => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockRejectedValue(cause)
  const view = await render(client)
  expect(view.textContent).toContain(
    cause instanceof SourceAuthoringError
      ? "errors.unauthorized"
      : "errors.unavailable",
  )
  expect(view.textContent).not.toContain("synthetic error")
  expect(saveButton(view).disabled).toBe(true)
})

test("неизвестная ошибка сохранения не раскрывает исключение и не повторяет запись", async () => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockResolvedValue(fixture())
  const save = vi
    .spyOn(client, "save")
    .mockRejectedValue(new Error("synthetic private details"))
  const view = await render(client)
  await edit(view)
  await act(async () => {
    saveButton(view).click()
    await Promise.resolve()
  })
  expect(view.textContent).toContain("errors.save_unconfirmed")
  expect(view.textContent).not.toContain("synthetic private details")
  expect(saveButton(view).disabled).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
})

test("поздний load предыдущего бота не заменяет текущий черновик", async () => {
  const client = new SourceAuthoringClient()
  let finish: ((envelope: SourceAuthoringEnvelopeV1) => void) | undefined
  vi.spyOn(client, "load")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(fixture())
  const view = await render(client)
  await act(async () => {
    root?.render(
      <ConnectedSupacrmSourceEditor botId="second-bot" client={client} />,
    )
    await Promise.resolve()
  })
  await edit(view)
  await act(async () => {
    required(finish)(fixture())
    await Promise.resolve()
  })
  expect(required(view.querySelector("input")).value).toBe("Мой черновик")
})

test("canvas drag отмечает черновик изменённым и передаёт новые координаты в CAS save", async () => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockResolvedValue(fixture())
  const save = vi.spyOn(client, "save").mockResolvedValue(fixture())
  const view = await render(client)
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>('[data-action="graph-select"]'),
    ).click(),
  )
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>('[data-action="graph-drag"]'),
    ).click(),
  )
  expect(saveButton(view).disabled).toBe(false)
  await act(async () => {
    saveButton(view).click()
    await Promise.resolve()
  })
  expect(save.mock.calls[0]?.[2].nodes[0]?.position).toEqual({ x: 10, y: 20 })
})

test("E1 dirty блокирует baseline validation и смену полей до явного Reload", async () => {
  const client = new SourceAuthoringClient()
  vi.spyOn(client, "load").mockResolvedValue({
    ...fixture(),
    source_hash: "raw",
  })
  const validate = vi.spyOn(client, "validate")
  const view = await render(client, {} as MessageFieldHttpClient)
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>('[data-action="message-dirty"]'),
    ).click(),
  )
  const button = required(
    view.querySelector<HTMLButtonElement>('[data-action="validate-source"]'),
  )
  expect(button.disabled).toBe(true)
  await act(() => button.click())
  expect(validate).not.toHaveBeenCalled()
  expect(required(view.querySelector("fieldset")).disabled).toBe(true)
})

test("E1 unknown блокирует все мутации и вызывает actual parent canonical reload", async () => {
  const client = new SourceAuthoringClient()
  const load = vi
    .spyOn(client, "load")
    .mockResolvedValue({ ...fixture(), source_hash: "raw" })
  const view = await render(client, {} as MessageFieldHttpClient)
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>('[data-action="message-unknown"]'),
    ).click(),
  )
  expect(
    required(
      view.querySelector<HTMLButtonElement>('[data-action="validate-source"]'),
    ).disabled,
  ).toBe(true)
  await act(async () => {
    required(
      view.querySelector<HTMLButtonElement>('[data-action="message-reload"]'),
    ).click()
    await Promise.resolve()
  })
  expect(load).toHaveBeenCalledTimes(2)
  expect(
    required(
      view.querySelector<HTMLButtonElement>('[data-action="validate-source"]'),
    ).disabled,
  ).toBe(false)
})

test.each([
  "message-dirty",
  "message-unknown",
])("graph selection не обходит %s и не теряет поле", async (action) => {
  const client = new SourceAuthoringClient()
  const base = fixture()
  const node = required(base.projection.nodes[0])
  vi.spyOn(client, "load").mockResolvedValue({
    ...base,
    source_hash: "raw",
    projection: {
      ...base.projection,
      nodes: [node, { ...node, sourceId: "other" }],
    },
  })
  const view = await render(client, {} as MessageFieldHttpClient)
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>(`[data-action="${action}"]`),
    ).click(),
  )
  await act(() =>
    required(
      view.querySelector<HTMLButtonElement>('[data-action="graph-select"]'),
    ).click(),
  )
  expect(view.querySelector('[data-message-source="node"]')).not.toBeNull()
  expect(view.querySelector('[data-message-source="other"]')).toBeNull()
  expect(
    required(
      view.querySelector<HTMLButtonElement>('[data-action="validate-source"]'),
    ).disabled,
  ).toBe(true)
})
