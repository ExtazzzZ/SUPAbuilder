import { beforeEach, expect, test, vi } from "vitest"
import { resolveApiStatusOwner } from "../src/message/resolve-api-status-owner"

const { candidates, contactInbox, conversation, legacyContactInbox } =
  vi.hoisted(() => ({
    candidates: vi.fn(),
    contactInbox: vi.fn(),
    conversation: vi.fn(),
    legacyContactInbox: vi.fn(),
  }))
vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: async () => ({ findStatusCandidates: candidates }),
  contactInboxRepository: {
    findWithContact: contactInbox,
    findWithConversationAndContact: legacyContactInbox,
  },
  findConversationById: conversation,
}))
const scope = { workspaceId: "ws", inboxId: "inbox", sourceId: "crm-job" }
const message = () => ({
  id: "message",
  workspaceId: "ws",
  sourceId: "crm-job",
  contactInboxId: "ci",
  conversationId: "conv",
  messageType: "outgoing",
  deletedAt: null,
})
const owner = () => ({
  id: "ci",
  inboxId: "inbox",
  channel: "api",
  contactId: "contact",
  contact: { id: "contact", workspaceId: "ws" },
  conversation: { id: "conv", workspaceId: "ws", contactId: "contact" },
})
beforeEach(() => {
  vi.clearAllMocks()
  candidates.mockResolvedValue([message()])
  const { conversation: expectedConversation, ...expectedContactInbox } =
    owner()
  contactInbox.mockResolvedValue(expectedContactInbox)
  conversation.mockResolvedValue(expectedConversation)
  legacyContactInbox.mockResolvedValue(owner())
})
test("proves exactly one outgoing owner using authenticated inbox and workspace", async () => {
  expect(await resolveApiStatusOwner(scope)).toEqual({
    message: message(),
    contactInbox: owner(),
  })
  expect(candidates).toHaveBeenCalledWith({
    workspaceId: "ws",
    sourceId: "crm-job",
  })
  expect(contactInbox).toHaveBeenCalledWith({
    where: { id: "ci", inboxId: "inbox" },
  })
})
test.each([
  { workspaceId: "foreign" },
  { sourceId: "foreign" },
  { contactInboxId: "other" },
  { conversationId: "other" },
  { messageType: "incoming" },
  { deletedAt: new Date() },
])("rejects mismatched Message %j", async (patch) => {
  candidates.mockResolvedValue([{ ...message(), ...patch }])
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_mismatch",
  )
})
test.each([
  { inboxId: "foreign" },
  { channel: "whatsapp" },
  { contactId: "foreign" },
  { contact: { id: "contact", workspaceId: "other" } },
])("rejects broken owner relationship %j", async (patch) => {
  contactInbox.mockResolvedValue({ ...owner(), ...patch })
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_mismatch",
  )
})
test("missing sourceId and orphan/foreign inbox remain pending", async () => {
  candidates.mockResolvedValueOnce([])
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_pending",
  )
  contactInbox.mockResolvedValueOnce(undefined)
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_pending",
  )
})
test("same source in another inbox does not replace the owner", async () => {
  candidates.mockResolvedValue([
    { ...message(), contactInboxId: "foreign" },
    message(),
  ])
  contactInbox.mockResolvedValueOnce(undefined)
  expect((await resolveApiStatusOwner(scope)).message.id).toBe("message")
})
test("multiple candidates from different shards are ambiguous", async () => {
  candidates.mockResolvedValue([message(), { ...message(), id: "message2" }])
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_ambiguous",
  )
})
test("partial shard failure never resolves a partial owner", async () => {
  candidates.mockRejectedValueOnce(new Error("shard unavailable"))
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "shard unavailable",
  )
  expect(contactInbox).not.toHaveBeenCalled()
})

test.each([
  { id: "other", workspaceId: "ws", contactId: "contact" },
  { id: "conv", workspaceId: "other", contactId: "contact" },
  { id: "conv", workspaceId: "ws", contactId: "other" },
  undefined,
])("rejects exact Conversation mismatch %j", async (row) => {
  conversation.mockResolvedValue(row)
  await expect(resolveApiStatusOwner(scope)).rejects.toThrow(
    "api_status_owner_mismatch",
  )
})

test.each([
  { selectedId: "dm", reverse: false },
  { selectedId: "source", reverse: false },
  { selectedId: "dm", reverse: true },
  { selectedId: "source", reverse: true },
])("DM and source conversations resolve exact Message owner %j", async ({
  selectedId,
  reverse,
}) => {
  const rows = [
    { id: "dm", sourceId: null, workspaceId: "ws", contactId: "contact" },
    {
      id: "source",
      sourceId: "post-1",
      workspaceId: "ws",
      contactId: "contact",
    },
  ]
  if (reverse) {
    rows.reverse()
  }
  const { conversation: _ignored, ...contact } = owner()
  contactInbox.mockResolvedValue(contact)
  // Models the old non-unique one-relation: its row depends on query order.
  legacyContactInbox.mockResolvedValue({ ...contact, conversation: rows[0] })
  candidates.mockResolvedValue([{ ...message(), conversationId: selectedId }])
  conversation.mockImplementation(({ conversationId, workspaceId }) =>
    Promise.resolve(
      rows.find(
        (row) => row.id === conversationId && row.workspaceId === workspaceId,
      ),
    ),
  )
  const resolved = await resolveApiStatusOwner(scope)
  expect(resolved.contactInbox.conversation.id).toBe(selectedId)
  expect(conversation).toHaveBeenCalledWith({
    conversationId: selectedId,
    workspaceId: "ws",
  })
  expect(legacyContactInbox).not.toHaveBeenCalled()
})
