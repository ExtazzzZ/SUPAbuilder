import {
  ApiHistoryPendingMessageError,
  apiHistorySchema,
  projectApiHistory,
  supacrmFulfillmentService,
} from "@chatbotx.io/business"
import { incomingApiMessageSchema } from "@chatbotx.io/integration-api"
import { enqueueIntegrationJob } from "@chatbotx.io/worker-config"
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { logger } from "@/lib/log"
import { possibleErrorsOnCreatingResource } from "@/lib/orpc/orpc-error-helper"
import { assertApiNotRateLimited } from "@/lib/rate-limit/api-rate-limit"
import { channelApiTokenAPI } from "@/orpc"
import { deliveryStatusJobOptions } from "../lib/delivery-status-job"

const assertNotRateLimited = (
  inboxId: string,
  resHeaders?: Headers,
): Promise<void> =>
  assertApiNotRateLimited({
    scope: "channel-api-rate-limit",
    key: inboxId,
    resHeaders,
  })

export const channelsPublicRouter = {
  fulfillmentScope: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/fulfillment-scope",
      summary: "Проверить владельца native исполнения",
      tags: ["API Channel"],
    })
    .input(z.object({ flowId: z.string().regex(/^\d+$/) }))
    .output(
      z.object({
        workspaceId: z.string(),
        inboxId: z.string(),
        flowId: z.string(),
      }),
    )
    .handler(({ input, context }) =>
      supacrmFulfillmentService.scope({
        flowId: input.flowId,
        workspaceId: context.workspace.id,
        inboxId: context.inbox.id,
      }),
    ),
  history: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/history",
      summary: "Записать историю без запуска bot-flow",
      description:
        "Проекция уже обработанных входящих и исходящих сообщений. Bearer-токен ограничен одним API inbox. sourceId и createdAt неизменяемы; revision растёт для правок/статусов. Повтор или устаревшая ревизия не меняет историю. Триггеры, отправки и платёжные действия не выполняются.",
      tags: ["API Channel"],
    })
    .input(apiHistorySchema)
    .output(
      z.object({
        accepted: z.boolean(),
        messageId: z.string(),
        changed: z.boolean(),
      }),
    )
    .errors({
      ...possibleErrorsOnCreatingResource,
      CONFLICT: {
        status: 409,
        message: "Исходное сообщение ещё не появилось в истории",
      },
    })
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id, context.resHeaders)
      try {
        return await projectApiHistory({
          workspaceId: context.workspace.id,
          inboxId: context.inbox.id,
          input,
        })
      } catch (error) {
        if (error instanceof ApiHistoryPendingMessageError) {
          throw new ORPCError("CONFLICT", { message: error.message })
        }
        throw error
      }
    }),
  sendMessage: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/messages",
      summary: "Send inbound message from your application",
      description:
        "`message.sourceId` is the idempotency key — sending the same value twice for the same contact does not create a duplicate message. Always send a stable id, never a random one per retry.",
      tags: ["API Channel"],
      successStatus: 202,
    })
    .input(incomingApiMessageSchema)
    .output(
      z.object({
        accepted: z.boolean(),
        messageSourceId: z.string(),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id, context.resHeaders)

      await enqueueIntegrationJob({
        type: "incomingMessage",
        data: {
          integrationType: "api",
          integrationIdentifier: context.inbox.id,
          payload: input,
        },
      })

      return { accepted: true, messageSourceId: input.message.sourceId }
    }),

  typing: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/typing",
      summary: "Report contact typing",
      description:
        "Records a typing indicator for the contact. Currently accepted and logged only; no downstream effect yet.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        contact: z
          .object({
            sourceId: z.string().min(1).describe("Contact id in your system."),
          })
          .describe("Contact who is typing."),
        typing: z
          .boolean()
          .describe("Whether the contact started or stopped typing."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id, context.resHeaders)

      // No downstream consumer for inbound "contact is typing" today (no
      // matching IntegrationJobAction/worker handler) — accepted and
      // acknowledged, not yet relayed anywhere. Revisit if/when the inbox UI
      // needs to reflect contact-side typing state.
      logger.debug(
        { inboxId: context.inbox.id, sourceId: input.contact.sourceId },
        "Received contact typing notification",
      )
    }),

  markRead: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/read",
      summary: "Report contact read outbound messages",
      description:
        "Marks the conversation as read up to this contact, mirroring a read receipt from the channel.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        contact: z
          .object({
            sourceId: z.string().min(1).describe("Contact id in your system."),
          })
          .describe("Contact who read the messages."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id, context.resHeaders)

      await enqueueIntegrationJob({
        type: "contactMarkAsRead",
        data: {
          integrationType: "api",
          integrationIdentifier: context.inbox.id,
          sourceConversationId: input.contact.sourceId,
          payload: input,
        },
      })
    }),

  deliveryStatus: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/delivery-status",
      summary: "Report delivery status for outbound message",
      description:
        "`messageId` correlates to the id returned in the outbound callback response, if one was supplied.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        messageId: z
          .string()
          .min(1)
          .describe(
            "Id of the message being reported on, echoed back from the outbound callback.",
          ),
        status: z
          .enum(["delivered", "failed", "read"])
          .describe("Delivery outcome for the message."),
        timestamp: z.string().describe("When the status change occurred."),
        error: z
          .unknown()
          .optional()
          .describe("Provider error details, present when status is `failed`."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id, context.resHeaders)

      await enqueueIntegrationJob(
        {
          type: "messageStatus",
          data: {
            integrationType: "api",
            integrationIdentifier: context.inbox.id,
            payload: input,
          },
        },
        await deliveryStatusJobOptions(context.inbox.id, input),
      )
    }),

  me: channelApiTokenAPI
    .route({
      method: "GET",
      path: "/v1/channels/api/me",
      summary: "Verify token and echo connected inbox identity",
      description:
        "Use this to confirm a token is valid and discover which inbox and workspace it is scoped to.",
      tags: ["API Channel"],
    })
    .output(
      z.object({
        inboxId: z.string(),
        inboxName: z.string(),
        workspaceId: z.string(),
      }),
    )
    .handler(({ context }) => ({
      inboxId: context.inbox.id,
      inboxName: context.inbox.name,
      workspaceId: context.workspace.id,
    })),
}
