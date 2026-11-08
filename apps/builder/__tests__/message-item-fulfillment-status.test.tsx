// @vitest-environment jsdom
import type { TenantSettings } from "@chatbotx.io/business"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { MessageItem } from "@/features/messages/components/message-item"
import type { MessageResourceWithRelations } from "@/features/messages/schema/resource"
import { TenantProvider } from "@/features/tenant/tenant-settings-provider"

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/lib/orpc/orpc", () => ({
  client: { flowsAPI: { fulfillmentStatus: read } },
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))
vi.mock("@/features/media-library/components/media-library-trigger", () => ({
  MediaLibraryTrigger: () => null,
}))
vi.mock("@/features/messages/components/whatsapp-call-card", () => ({
  WhatsappCallCard: () => null,
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement
let client: QueryClient
const settings = {
  storageUrl: "https://cdn.example.com",
} as unknown as TenantSettings
const message = {
  id: "1",
  workspaceId: "10",
  conversationId: "80",
  createdAt: new Date(0),
  messageType: "incoming",
  type: "message",
  text: "",
  deletedAt: null,
  attributes: null,
  contentAttributes: {
    crmFulfillmentExecution: {
      flowId: "30",
      fulfillmentRef: "123e4567-e89b-42d3-a456-426614174000",
    },
  },
  attachments: [],
} as unknown as MessageResourceWithRelations
afterEach(async () => {
  await act(() => root?.unmount())
  client.clear()
  container.remove()
  vi.clearAllMocks()
})
test.each([
  false,
  true,
])("inbox message exposes actual status card only to staff (guest=%s)", async (guestDisplay) => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <TenantProvider settings={settings}>
          <MessageItem guestDisplay={guestDisplay} message={message} />
        </TenantProvider>
      </QueryClientProvider>,
    ),
  )
  expect(Boolean(container.querySelector('section[aria-label="title"]'))).toBe(
    !guestDisplay,
  )
  expect(read).not.toHaveBeenCalled()
})
