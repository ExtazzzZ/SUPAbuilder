import { db } from "@chatbotx.io/database/client"
import {
  createMessageRepository,
  type MessageWithAttachments,
  recordApiHistoryActivity,
  resolveApiHistoryContact,
} from "@chatbotx.io/database/repositories"
import type { MessageModel } from "@chatbotx.io/database/types"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import { createId } from "@chatbotx.io/utils"
import { conversationService } from "../conversation/service"
import { messageService } from "../message/service"
import {
  queueMessageCreatedEvent,
  queueWorkspaceRealtimeEvent,
} from "../platform/realtime-broadcast"
import { type ApiHistoryInput, apiHistorySchema } from "./schema"

/** Исходное сообщение ещё не получило provider sourceId; повторяется только проекция. */
export class ApiHistoryPendingMessageError extends Error {}

/** Записывает историю без входящей очереди, триггеров, отправок и платёжных действий. */
export const projectApiHistory = async (props: {
  workspaceId: string
  inboxId: string
  input: ApiHistoryInput
}) => {
  const input = apiHistorySchema.parse(props.input)
  const result = await db.transaction(async (tx) => {
    const contactInbox = await resolveApiHistoryContact({
      tx,
      workspaceId: props.workspaceId,
      inboxId: props.inboxId,
      ...input.contact,
    })
    const conversation = await conversationService.findOrCreate({
      tx,
      workspaceId: props.workspaceId,
      contactId: contactInbox.contactId,
      sourceId: null,
    })
    const repo = await createMessageRepository(tx)
    // Native сообщение создаётся раньше callback CRM; нижняя граница должна
    // покрывать оба времени и обязательна для sharded repository.
    const sinceTime = new Date(
      Math.min(
        conversation.createdAt.getTime(),
        new Date(input.message.createdAt).getTime(),
      ) - 86_400_000,
    )
    // Пространство имён не позволяет одному API-контакту менять историю другого.
    const sourceId = `api-history:${JSON.stringify([props.inboxId, input.contact.sourceId, input.message.sourceId])}`
    const normal = await repo.findBySourceId(
      input.message.sourceId,
      conversation.id,
      props.workspaceId,
      sinceTime,
    )
    const normalOwned =
      normal?.contactInboxId === contactInbox.id &&
      normal.messageType === input.message.direction
    const existing = normalOwned
      ? normal
      : await repo.findBySourceId(
          sourceId,
          conversation.id,
          props.workspaceId,
          sinceTime,
        )
    if (!existing && input.message.requireExisting) {
      throw new ApiHistoryPendingMessageError(
        "Исходное сообщение ещё не появилось в истории; повторите только проекцию",
      )
    }
    if (
      existing &&
      (existing.contactInboxId !== contactInbox.id ||
        existing.messageType !== input.message.direction)
    ) {
      throw new Error(
        "Сообщение истории принадлежит другому контакту или направлению",
      )
    }
    const previous = existing?.contentAttributes?.apiHistory as
      | Record<string, unknown>
      | undefined
    if (
      existing &&
      Number(previous?.revision ?? -1) >= input.message.revision
    ) {
      return { message: existing, conversation, changed: false, isNew: false }
    }
    if (
      existing &&
      previous?.externalCreatedAt &&
      previous.externalCreatedAt !==
        new Date(input.message.createdAt).toISOString()
    ) {
      throw new Error(
        "Направление и время исходного сообщения истории неизменяемы",
      )
    }
    if (
      previous?.platformMessageId &&
      input.message.platformMessageId &&
      previous.platformMessageId !== input.message.platformMessageId
    ) {
      throw new Error("Платформенный ID исходного сообщения истории неизменяем")
    }
    const original =
      existing && !previous
        ? await repo.findById({
            id: existing.id,
            createdAt: existing.createdAt,
            workspaceId: props.workspaceId,
          })
        : null
    const snapshots = Array.isArray(previous?.snapshots)
      ? previous.snapshots
      : []
    const contentAttributes = {
      ...input.message.contentAttributes,
      apiHistory: {
        sourceId: input.message.sourceId,
        revision: input.message.revision,
        externalCreatedAt: new Date(input.message.createdAt).toISOString(),
        deliveryStatus: input.message.deliveryStatus,
        platformMessageId:
          input.message.platformMessageId ?? previous?.platformMessageId,
        deleted: input.message.deleted,
        attachments: input.message.attachments,
        // Не сохраняем повторно всю цепочку снимков внутри каждого снимка.
        snapshots: existing
          ? [
              ...snapshots,
              {
                revision: previous?.revision,
                text: existing.text,
                platformMessageId: previous?.platformMessageId,
                deliveryStatus: previous?.deliveryStatus,
                deleted: previous?.deleted,
                attachments: previous?.attachments ?? original?.attachments,
                sourceId: existing.sourceId,
                contentAttributes: Object.fromEntries(
                  Object.entries(existing.contentAttributes ?? {}).filter(
                    ([key]) => key !== "apiHistory",
                  ),
                ),
              },
            ]
          : [],
      },
    }
    const attachments = input.message.deleted
      ? []
      : input.message.attachments.map((attachment) => ({
          id: createId(),
          workspaceId: props.workspaceId,
          conversationId: conversation.id,
          fileType: attachment.fileType,
          mimeType: attachment.mimeType,
          originPath: attachment.url,
          sourceId: attachment.url,
          name: attachment.name,
          size: 0,
        }))
    let message: MessageModel | null
    if (existing) {
      await messageService.edit({
        tx,
        workspaceId: props.workspaceId,
        id: existing.id,
        createdAt: existing.createdAt,
        text: input.message.deleted
          ? "Сообщение удалено"
          : (input.message.text ?? ""),
        attachments,
        replaceAttachments: true,
      })
      await repo.updateContentAttributes(
        existing.id,
        props.workspaceId,
        contentAttributes,
        existing.createdAt,
      )
      message = await repo.findById({
        id: existing.id,
        createdAt: existing.createdAt,
        workspaceId: props.workspaceId,
      })
    } else {
      message = await repo.createWithAttachments(
        {
          workspaceId: props.workspaceId,
          contactInboxId: contactInbox.id,
          conversationId: conversation.id,
          sourceId,
          createdAt: new Date(input.message.createdAt),
          messageType: input.message.direction,
          contentType: "text",
          senderType:
            input.message.direction === "incoming" ? "contact" : "bot",
          senderId:
            input.message.direction === "incoming"
              ? contactInbox.contactId
              : null,
          text: input.message.deleted
            ? "Сообщение удалено"
            : input.message.text,
          contentAttributes,
        },
        attachments,
      )
    }
    if (!message) {
      throw new Error("Сообщение истории не найдено")
    }
    await recordApiHistoryActivity({
      tx,
      workspaceId: props.workspaceId,
      contactInboxId: contactInbox.id,
      conversationId: conversation.id,
      at: message.createdAt,
      direction: input.message.direction,
    })
    return { message, conversation, changed: true, isNew: !existing }
  })
  if (result.changed) {
    await conversationService.invalidate({
      workspaceId: props.workspaceId,
      ids: [result.conversation.id],
    })
    const attachments = input.message.deleted ? [] : input.message.attachments
    if (result.isNew) {
      await queueMessageCreatedEvent(
        props.workspaceId,
        {
          ...result.message,
          attachments: (
            (result.message as MessageWithAttachments).attachments ?? []
          ).map((attachment) => ({
            ...attachment,
            url: attachment.originPath,
          })),
        },
        result.conversation,
        props.inboxId,
      )
    } else {
      const attachment = attachments[0]
      await queueWorkspaceRealtimeEvent(props.workspaceId, {
        eventType: RealtimeEventType.messageUpdated,
        data: {
          messageId: result.message.id,
          newText: result.message.text ?? "",
          removedAttachment: attachments.length === 0,
          newAttachmentPath: attachment?.url ?? null,
          newAttachmentPublicUrl: attachment?.url ?? null,
          newAttachmentMimeType: attachment?.mimeType ?? null,
        },
        route: routeForConversation(result.conversation, props.inboxId),
      })
      await queueWorkspaceRealtimeEvent(props.workspaceId, {
        eventType: RealtimeEventType.messageContentUpdated,
        data: {
          messageId: result.message.id,
          contentAttributes: result.message.contentAttributes ?? {},
        },
        route: routeForConversation(result.conversation, props.inboxId),
      })
    }
  }
  return {
    accepted: true,
    messageId: result.message.id,
    changed: result.changed,
  }
}
