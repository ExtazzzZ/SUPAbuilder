import {
  contactInboxRepository,
  createMessageRepository,
  findConversationById,
} from "@chatbotx.io/database/repositories"
import type {
  ContactInboxModel,
  ContactModel,
  ConversationModel,
  MessageModel,
} from "@chatbotx.io/database/types"

type ApiStatusOwner = {
  message: MessageModel
  contactInbox: ContactInboxModel & {
    contact: ContactModel
    conversation: ConversationModel
  }
}

/** Ownership разрешается до любого события или изменения read-state. */
export const resolveApiStatusOwner = async (props: {
  workspaceId: string
  inboxId: string
  sourceId: string
}) => {
  if (!(props.workspaceId && props.inboxId && props.sourceId)) {
    throw new Error("api_status_owner_mismatch")
  }
  const repository = await createMessageRepository()
  const candidates = await repository.findStatusCandidates({
    workspaceId: props.workspaceId,
    sourceId: props.sourceId,
  })
  const owners: ApiStatusOwner[] = []
  for (const message of candidates) {
    const contactInbox = await contactInboxRepository.findWithContact({
      where: { id: message.contactInboxId, inboxId: props.inboxId },
    })
    // Один sourceId может законно использоваться другим API inbox.
    if (!contactInbox) {
      continue
    }
    const { contact } = contactInbox
    const conversation = await findConversationById({
      conversationId: message.conversationId,
      workspaceId: props.workspaceId,
    })
    if (
      message.workspaceId !== props.workspaceId ||
      message.sourceId !== props.sourceId ||
      message.messageType !== "outgoing" ||
      message.deletedAt !== null ||
      message.contactInboxId !== contactInbox.id ||
      contactInbox.inboxId !== props.inboxId ||
      contactInbox.channel !== "api" ||
      !conversation ||
      !contact ||
      message.conversationId !== conversation.id ||
      conversation.workspaceId !== props.workspaceId ||
      contact.workspaceId !== props.workspaceId ||
      conversation.contactId !== contactInbox.contactId ||
      contact.id !== contactInbox.contactId
    ) {
      throw new Error("api_status_owner_mismatch")
    }
    owners.push({ message, contactInbox: { ...contactInbox, conversation } })
    if (owners.length > 1) {
      throw new Error("api_status_owner_ambiguous")
    }
  }
  const owner = owners[0]
  if (!owner) {
    throw new Error("api_status_owner_pending")
  }
  return owner
}
