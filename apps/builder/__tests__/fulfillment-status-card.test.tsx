// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { FulfillmentStatusCard } from "../src/features/flows/supacrm-fulfillment/fulfillment-status-card"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}))
vi.mock("@/lib/orpc/orpc", () => ({
  client: { flowsAPI: { fulfillmentStatus: read } },
}))
const ref = "123e4567-e89b-42d3-a456-426614174000"
const execution = { flowId: "30", fulfillmentRef: ref }
let root: Root | undefined
let container: HTMLDivElement
let query: QueryClient
async function render(
  attributes: unknown = { crmFulfillmentExecution: execution },
) {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(() =>
    root?.render(
      <QueryClientProvider client={query}>
        <FulfillmentStatusCard attributes={attributes} workspaceId="10" />
      </QueryClientProvider>,
    ),
  )
}
async function open() {
  const button = container.querySelector("button")
  if (!button) {
    throw new Error("Missing status action")
  }
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}
afterEach(async () => {
  await act(() => root?.unmount())
  query?.clear()
  container?.remove()
  vi.clearAllMocks()
})
test("actual UI consumer reads owned execution and separates purchase/delivery/native/required parts", async () => {
  read.mockResolvedValue({
    fulfillmentRef: ref,
    purchaseStatus: "completed",
    deliveryStatus: "prepared",
    nativeStatus: "waiting",
    parts: [
      { key: "author_instruction", status: "sent" },
      { key: "apple_code_reference", status: "prepared" },
    ],
  })
  await render()
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain("supacrmFulfillment.status.source")
  expect(container.querySelector("input")).toBeNull()
  await open()
  expect(read).toHaveBeenCalledWith(
    { workspaceId: "10", ...execution },
    expect.anything(),
  )
  for (const label of [
    "purchase",
    "delivery",
    "native",
    "author_instruction",
    "apple_code_reference",
  ]) {
    expect(container.textContent).toContain(
      `supacrmFulfillment.status.${label}`,
    )
  }
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.states.waiting",
  )
})
test("ref unavailable before first terminal event or malformed anchor produces no query/UI", async () => {
  await render({
    crmFulfillmentExecution: { fulfillmentRef: "intent-id", flowId: "30" },
  })
  expect(container.textContent).toBe("")
  expect(read).not.toHaveBeenCalled()
})
test("safe refusal hides transport error and stale status; unknown/review remain separate DTO states", async () => {
  read.mockRejectedValue(new Error("PRIVATE_PROVIDER_SENTINEL"))
  await render()
  await open()
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.unavailable",
  )
  expect(container.textContent).not.toContain("PRIVATE_PROVIDER_SENTINEL")
  expect(read).toHaveBeenCalledTimes(1)
})

test.each([
  "unknown",
  "review",
])("owned current %s status remains inspectable after terminal anchor", async (nativeStatus) => {
  read.mockResolvedValue({
    fulfillmentRef: ref,
    purchaseStatus: "completed",
    deliveryStatus: "unknown",
    nativeStatus,
    parts: [
      { key: "author_instruction", status: "unknown" },
      { key: "apple_code_reference", status: "prepared" },
    ],
    errorCode: "native_entry_unconfirmed",
  })
  await render()
  await open()
  expect(container.textContent).toContain(
    `supacrmFulfillment.status.states.${nativeStatus}`,
  )
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.reviewReason",
  )
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.states.completed",
  )
})

test("refresh refusal removes a previously visible status instead of showing stale success", async () => {
  read
    .mockResolvedValueOnce({
      fulfillmentRef: ref,
      purchaseStatus: "completed",
      deliveryStatus: "sent",
      nativeStatus: "sent",
      parts: [],
    })
    .mockRejectedValueOnce(new Error("PRIVATE_SENTINEL"))
  await render()
  await open()
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.states.completed",
  )
  await open()
  expect(container.textContent).toContain(
    "supacrmFulfillment.status.unavailable",
  )
  expect(container.textContent).not.toContain(
    "supacrmFulfillment.status.states.completed",
  )
  expect(container.textContent).not.toContain("PRIVATE_SENTINEL")
})

test.each([
  "refunded",
  "rejected",
])("provider purchase %s is factual and distinct from native review", async (purchaseStatus) => {
  read.mockResolvedValue({
    fulfillmentRef: ref,
    purchaseStatus,
    deliveryStatus: "pending",
    nativeStatus: "review",
    parts: [],
  })
  await render()
  await open()
  const purchase = Array.from(container.querySelectorAll("dt")).find(
    (node) => node.textContent === "supacrmFulfillment.status.purchase",
  )?.nextElementSibling
  const native = Array.from(container.querySelectorAll("dt")).find(
    (node) => node.textContent === "supacrmFulfillment.status.native",
  )?.nextElementSibling
  expect(purchase?.textContent).toBe(
    `supacrmFulfillment.status.states.${purchaseStatus}`,
  )
  expect(purchase?.textContent).not.toContain("states.unknown")
  expect(native?.textContent).toBe("supacrmFulfillment.status.states.review")
})
