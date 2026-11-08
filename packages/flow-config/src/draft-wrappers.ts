import { z } from "zod"
import {
  FlowAuthoringException,
  zodErrorToFlowAuthoringErrors,
} from "./authoring/errors"
import { sendMessageNodeSchema } from "./nodes/send-message"

const wrapperKeys = [
  "supacrmReminder",
  "supacrmDataRequest",
  "supacrmOperator",
  "supacrmCheckout",
  "supacrmFulfillment",
  "supacrmProduct",
  "supacrmForm",
  "supacrmFormTemplate",
  "supacrmVariable",
] as const
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Drafts may be incomplete. Only declared native wrappers must remain executable
 * as authored; validate their existing contract without stripping plugin metadata. */
export const refineDraftWrappers = (
  nodes: unknown[],
  ctx: z.RefinementCtx,
): void => {
  nodes.forEach((node, index) => {
    const raw = record(node)
    const details = record(record(raw?.data)?.details)
    if (!(details && wrapperKeys.some((key) => Object.hasOwn(details, key)))) {
      return
    }
    if (raw?.type !== "sendMessage") {
      ctx.addIssue({
        code: "custom",
        path: [index, "type"],
        message: "Native wrappers require a sendMessage node.",
      })
      return
    }
    const result =
      sendMessageNodeSchema.shape.data.shape.details.safeParse(details)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: [index, "data", "details", ...issue.path],
          message: issue.message,
        })
      }
    }
  })
}

const draftWrappersSchema = z.object({
  nodes: z.array(z.unknown()).superRefine(refineDraftWrappers),
})
export const assertDraftWrappers = (nodes: unknown[]): void => {
  const result = draftWrappersSchema.safeParse({ nodes })
  if (!result.success) {
    throw new FlowAuthoringException(
      zodErrorToFlowAuthoringErrors(result.error, "invalidGraph"),
    )
  }
}
