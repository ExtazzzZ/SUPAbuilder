import { z } from "zod"

/** Проекция уже обработанного события: никаких команд или запуска bot-flow. */
export const apiHistorySchema = z.object({
  contact: z.object({
    sourceId: z.string().min(1).max(250),
    firstName: z.string().max(250).optional(),
    lastName: z.string().max(250).optional(),
  }),
  message: z.object({
    sourceId: z.string().min(1).max(250),
    requireExisting: z.boolean().default(false),
    createdAt: z.iso.datetime({ offset: true }),
    direction: z.enum(["incoming", "outgoing"]),
    text: z.string().max(100_000).nullable().optional(),
    revision: z.number().int().min(0).default(0),
    deliveryStatus: z
      .enum(["queued", "sent", "delivered", "read", "failed", "unknown"])
      .optional(),
    platformMessageId: z.string().max(250).optional(),
    deleted: z.boolean().default(false),
    attachments: z
      .array(
        z.object({
          url: z.url(),
          fileType: z.enum(["image", "audio", "video", "gif", "file"]),
          mimeType: z.string().max(250),
          name: z.string().max(500).optional(),
        }),
      )
      .max(30)
      .default([]),
    contentAttributes: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type ApiHistoryInput = z.infer<typeof apiHistorySchema>
