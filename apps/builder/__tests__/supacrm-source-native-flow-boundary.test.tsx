// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { FlowDetail } from "../src/features/flows/flow-detail"
import type { FlowResource } from "../src/features/flows/schema/resource"
import type { NativeSourceBinding } from "../src/lib/source-authoring-native/authorization"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const mocks = vi.hoisted(() => ({
  factory: vi.fn(() => ({ marker: {} })),
  mounted: vi.fn(),
  unmounted: vi.fn(),
  transportReceived: vi.fn(),
}))
vi.mock("../src/features/flows/supacrm-source/native/document-port", () => ({
  createNativeSourceBrowserPort: mocks.factory,
}))
vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("../src/features/flows/react-flow/stores/step-store-provider", () => ({
  StepStoreProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock(
  "../src/features/flows/react-flow/stores/flow-template-store-provider",
  () => ({
    FlowTemplateStoreProvider: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  }),
)
vi.mock(
  "../src/features/flows/react-flow/stores/whatsapp-flow-store-provider",
  () => ({
    WhatsappFlowStoreProvider: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  }),
)
vi.mock(
  "../src/features/appointment-calendars/provider/appointment-calendar-store-context",
  () => ({
    AppointmentCalendarStoreProvider: ({
      children,
    }: {
      children: ReactNode
    }) => <>{children}</>,
  }),
)
vi.mock(
  "../src/features/platform-credentials/provider/platform-credentials-store-context",
  () => ({
    PlatformCredentialsStoreProvider: ({
      children,
    }: {
      children: ReactNode
    }) => <>{children}</>,
  }),
)
vi.mock(
  "../src/features/questionnaires/provider/questionnaire-store-context",
  () => ({
    QuestionnaireStoreProvider: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  }),
)
vi.mock("../src/features/ai-tools/provider/ai-tools-store-context", () => ({
  AIToolsStoreProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock(
  "../src/features/email-topics/provider/email-topic-store-context",
  () => ({
    EmailTopicStoreProvider: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  }),
)
vi.mock("../src/features/flows/react-flow/frame", async () => {
  const { useState, useEffect } = await import("react")
  return {
    ReactFlowFrame: ({
      sourcePort,
      sourceBinding,
    }: {
      sourcePort: unknown
      sourceBinding: NativeSourceBinding
    }) => {
      const [draft, setDraft] = useState("A")
      useEffect(() => {
        mocks.mounted()
        return () => {
          mocks.unmounted()
        }
      }, [])
      useEffect(() => {
        mocks.transportReceived(sourcePort, sourceBinding)
        setDraft("A")
      }, [sourcePort, sourceBinding])
      return (
        <label>
          Локальный черновик
          <textarea
            aria-label="Локальный черновик"
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
        </label>
      )
    },
  }
})
const binding: NativeSourceBinding = {
  kind: "source",
  bindingId: "binding-1",
  workspaceId: "1",
  flowId: "2",
  registryId: "00000000-0000-4000-8000-000000000001",
  bindingVersion: 1,
  capabilities: ["view", "slot", "compile", "validate", "publish"],
}
const flow = {
  id: "2",
  workspaceId: "1",
  name: "Сценарий",
  active: true,
  enableInInbox: true,
  currentVersionId: null,
  draftVersionId: null,
  folderId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as FlowResource
let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => {
  await act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})
async function render(sourceBinding = binding) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await rerender(sourceBinding)
}
async function rerender(sourceBinding: NativeSourceBinding) {
  await act(() =>
    root?.render(<FlowDetail flow={flow} sourceBinding={sourceBinding} />),
  )
}
function input() {
  const element = container.querySelector("textarea")
  if (!element) {
    throw new Error("Нет локального черновика frame")
  }
  return element
}
async function typeDraft() {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input(), "D")
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

test("повторная серверная metadata того же binding сохраняет D, port и mount native frame", async () => {
  await render()
  await typeDraft()
  const firstPort = mocks.transportReceived.mock.calls[0]?.[0]
  const firstBinding = mocks.transportReceived.mock.calls[0]?.[1]
  await rerender({ ...binding, capabilities: [...binding.capabilities] })
  expect(input().value).toBe("D")
  expect(mocks.factory).toHaveBeenCalledTimes(1)
  expect(mocks.mounted).toHaveBeenCalledTimes(1)
  expect(mocks.unmounted).not.toHaveBeenCalled()
  expect(mocks.transportReceived).toHaveBeenLastCalledWith(
    firstPort,
    firstBinding,
  )
})

test("реальная смена binding на том же flow создаёт новый port и перемонтирует native frame", async () => {
  await render()
  await typeDraft()
  await rerender({
    ...binding,
    bindingId: "binding-2",
    registryId: "00000000-0000-4000-8000-000000000002",
  })
  expect(input().value).toBe("A")
  expect(mocks.factory).toHaveBeenCalledTimes(2)
  expect(mocks.mounted).toHaveBeenCalledTimes(2)
  expect(mocks.unmounted).toHaveBeenCalledTimes(1)
})
