import { createId } from "@chatbotx.io/utils"
import { and, type DatabaseClient, eq, sql } from "../client"
import { contactInboxModel, contactModel, conversationModel } from "../schema"

/** Сериализация проекций одного контакта и создание без событий автоматизации. */
export const resolveApiHistoryContact = async (props: {
  tx: DatabaseClient
  workspaceId: string
  inboxId: string
  sourceId: string
  firstName?: string
  lastName?: string
}) => {
  const { tx, workspaceId, inboxId, sourceId, firstName, lastName } = props
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`api-history:${inboxId}:${sourceId}`}, 0))`,
  )
  const existing = await tx.query.contactInboxModel.findFirst({
    where: { inboxId, sourceId, inbox: { workspaceId } },
  })
  if (existing) {
    return existing
  }
  const inbox = await tx.query.inboxModel.findFirst({
    where: { id: inboxId, workspaceId, channel: "api" },
  })
  if (!inbox) {
    throw new Error("API inbox истории не найден")
  }
  const contactId = createId()
  await tx
    .insert(contactModel)
    .values({ id: contactId, workspaceId, firstName, lastName })
  const [created] = await tx
    .insert(contactInboxModel)
    .values({
      id: createId(),
      contactId,
      originalContactId: contactId,
      inboxId,
      sourceId,
      channel: "api",
      source: "direct",
    })
    .returning()
  if (!created) {
    throw new Error("Контакт истории не создан")
  }
  return created
}

/** Историческая активность сдвигает только временные метки, сохраняя состояние bot-flow. */
export const recordApiHistoryActivity = async (props: {
  tx: DatabaseClient
  workspaceId: string
  contactInboxId: string
  conversationId: string
  at: Date
  direction: "incoming" | "outgoing"
}) => {
  const { tx, at } = props
  await tx
    .update(contactInboxModel)
    .set({
      firstInteractionAt: sql`LEAST(${contactInboxModel.firstInteractionAt}, ${at})`,
      lastMessageAt: sql`GREATEST(${contactInboxModel.lastMessageAt}, ${at})`,
      ...(props.direction === "incoming"
        ? {
            lastIncomingMessageAt: sql`GREATEST(${contactInboxModel.lastIncomingMessageAt}, ${at})`,
          }
        : {
            lastOutboundMessageAt: sql`GREATEST(${contactInboxModel.lastOutboundMessageAt}, ${at})`,
          }),
    })
    .where(eq(contactInboxModel.id, props.contactInboxId))
  await tx
    .update(conversationModel)
    .set({
      createdAt: sql`LEAST(${conversationModel.createdAt}, ${at})`,
      lastActivityAt: sql`GREATEST(${conversationModel.lastActivityAt}, ${at})`,
    })
    .where(
      and(
        eq(conversationModel.id, props.conversationId),
        eq(conversationModel.workspaceId, props.workspaceId),
      ),
    )
}
