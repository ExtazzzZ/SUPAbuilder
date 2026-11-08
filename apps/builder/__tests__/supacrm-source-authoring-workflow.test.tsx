/* biome-ignore-all lint/suspicious/useAwait: Асинхронные act ждут React effects; fake fetch сохраняет Promise API без внешнего IO. */
// @vitest-environment jsdom
import type {
  SourceAuthoringEnvelopeV1,
  SourceLogicProjectionV1,
  SourceProjection,
} from "@chatbotx.io/flow-config"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ConnectedSupacrmSourceEditor } from "../src/features/flows/supacrm-source/connected-editor"
import { SourceAuthoringClient } from "../src/features/flows/supacrm-source/source-client"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("../src/features/flows/supacrm-source/source-graph", () => ({
  SupacrmSourceGraph: () => null,
}))
vi.mock("../src/features/flows/supacrm-source/source-editor", () => ({
  SupacrmSourceEditor: ({
    projection,
    onChange,
  }: {
    projection: SourceProjection
    onChange: (p: SourceProjection) => void
  }) => (
    <button
      data-action="edit-message"
      onClick={() =>
        onChange({
          ...projection,
          nodes: projection.nodes.map((n) => ({
            ...n,
            label: "Правка сообщения",
          })),
        })
      }
      type="button"
    >
      edit message
    </button>
  ),
}))
vi.mock("../src/features/flows/supacrm-source/logic-editor", () => ({
  SourceLogicEditor: ({
    logic,
    onChange,
  }: {
    logic: SourceLogicProjectionV1
    onChange: (v: SourceLogicProjectionV1) => void
  }) => (
    <>
      <pre data-logic>{JSON.stringify(logic)}</pre>
      <button
        data-action="edit-logic"
        onClick={() =>
          onChange({
            ...logic,
            edits: logic.edits.map((e) =>
              e.kind === "guard"
                ? {
                    ...e,
                    expression: {
                      kind: "unary",
                      operator: "not",
                      operand: e.expression,
                    },
                  }
                : e,
            ),
          })
        }
        type="button"
      >
        edit logic
      </button>
    </>
  ),
}))
const bot = "11111111-1111-4111-8111-111111111111"
const raw = "a".repeat(64),
  pin = "b".repeat(64)
const nextRaw = "c".repeat(64),
  nextPin = "d".repeat(64)
function fixture(): SourceAuthoringEnvelopeV1 {
  return {
    version: "supacrm.source-authoring.v1",
    draft_version: 5,
    source_revision: pin,
    source_hash: raw,
    projection: {
      version: "supacrm.source-projection.v1",
      sourceRevision: pin,
      nodes: [
        {
          sourceId: "block",
          scenarioId: "scenario",
          kind: "exec_sq",
          label: "Блок",
          ports: [],
          bindings: [],
          content: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      symbols: [],
    },
    diagnostics: [],
    publishable: false,
    logic: {
      dto_version: "1.0.0",
      source_hash: raw,
      diagnostics: [],
      publishable: false,
      edits: [
        {
          kind: "guard",
          expected_source_hash: raw,
          target: {
            scenario_id: "scenario",
            block_id: "block",
            path: "params.expr",
            start: 0,
            end: 0,
            sequence: 0,
          },
          expression: {
            kind: "literal_slot",
            slot_id: "existing-slot",
            declared_type: "bool",
          },
        },
      ],
    },
  }
}
let root: Root | undefined, host: HTMLDivElement
async function mount(client: SourceAuthoringClient) {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ConnectedSupacrmSourceEditor botId={bot} client={client} />)
  })
}
function button(action: string) {
  const value = host.querySelector<HTMLButtonElement>(
    `[data-action="${action}"]`,
  )
  if (!value) {
    throw new Error("Нет кнопки fixture")
  }
  return value
}
async function click(action: string) {
  await act(async () => {
    button(action).click()
  })
}
afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = undefined
  host?.remove()
})

test("guard edit → compile → validate → publish использует новую pinned revision и CAS", async () => {
  let value = fixture()
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) => {
      if (String(url).endsWith("/compile")) {
        const patch = JSON.parse(String(init?.body))
        expect(patch.source_revision).toBe(pin)
        expect(patch.edits[0].expected_source_hash).toBe(raw)
        value = {
          ...value,
          source_revision: nextPin,
          source_hash: nextRaw,
          candidate_revision: nextPin,
          draft_version: 6,
          projection: { ...value.projection, sourceRevision: nextPin },
          logic: {
            ...required(value.logic),
            source_hash: nextRaw,
            edits: patch.edits.map((edit: object) => ({
              ...edit,
              expected_source_hash: nextRaw,
            })),
          },
        }
      }
      if (String(url).endsWith("/validate")) {
        value = { ...value, publishable: true }
      }
      if (String(url).endsWith("/publish")) {
        expect(JSON.parse(String(init?.body)).source_revision).toBe(nextPin)
        value = { ...value, published_revision: nextPin }
      }
      return Response.json(value)
    })
  await mount(new SourceAuthoringClient(request))
  expect(button("publish-source").disabled).toBe(true)
  await click("edit-logic")
  expect(button("validate-source").disabled).toBe(true)
  await click("compile-source")
  expect(button("publish-source").disabled).toBe(true)
  await click("validate-source")
  expect(button("publish-source").disabled).toBe(false)
  await click("publish-source")
  expect(host.textContent).toContain("versionPublished")
  expect(
    request.mock.calls.map(([url]) => String(url).split("/").pop()),
  ).toEqual(["projection", "compile", "validate", "publish"])
})

test("layout save сохраняет несохранённую логику и следующий compile использует новый draft CAS", async () => {
  let value = fixture()
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) => {
      if (init?.method === "PATCH") {
        value = { ...value, draft_version: 6 }
      }
      if (String(url).endsWith("/compile")) {
        expect(JSON.parse(String(init?.body)).expected_draft_version).toBe(6)
        value = { ...value, draft_version: 7 }
      }
      return Response.json(value)
    })
  await mount(new SourceAuthoringClient(request))
  await click("edit-logic")
  await click("edit-message")
  expect(button("compile-source").disabled).toBe(true)
  await click("save-draft")
  expect(host.querySelector("[data-logic]")?.textContent).toContain('"unary"')
  expect(button("compile-source").disabled).toBe(false)
  await click("compile-source")
})

test("rejected compile показывает diagnostics, сохраняет выражение и не запускает publish", async () => {
  const value = fixture()
  const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith("/compile")
      ? Response.json(
          {
            version: "supacrm.source-authoring.v1",
            diagnostics: [
              { code: "authoring_function_unregistered", block_id: "block" },
            ],
            publishable: false,
          },
          { status: 422 },
        )
      : Response.json(value),
  )
  await mount(new SourceAuthoringClient(request))
  await click("edit-logic")
  await click("compile-source")
  expect(host.textContent).toContain("authoring_function_unregistered")
  expect(host.querySelector("[data-logic]")?.textContent).toContain('"unary"')
  expect(button("publish-source").disabled).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
})

test("потерянный compile блокирует повтор до явного reload", async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/compile")) {
      throw new Error("synthetic-secret")
    }
    return Response.json(fixture())
  })
  await mount(new SourceAuthoringClient(request))
  await click("edit-logic")
  await click("compile-source")
  expect(button("compile-source").disabled).toBe(true)
  expect(host.textContent).toContain("errors.save_unconfirmed")
  expect(host.textContent).not.toContain("synthetic-secret")
  expect(request).toHaveBeenCalledTimes(2)
})
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Нет fixture")
  }
  return value
}
