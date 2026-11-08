import {
  fulfillmentStatusSchema,
  fulfillmentStatusService,
} from "@chatbotx.io/business"
import { z } from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI, workspaceTokenAuthAPIForScope } from "@/orpc"

const statusInput = z.object({
  flowId: z.string().regex(/^\d+$/),
  fulfillmentRef: z.uuid(),
})
export const privateFulfillmentStatus = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/flows/{flowId}/fulfillment/{fulfillmentRef}",
  })
  .input(withWorkspaceIdSchema.and(statusInput))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(fulfillmentStatusSchema)
  .handler(({ input, context }) => {
    context.resHeaders?.set("Cache-Control", "private, no-store")
    return fulfillmentStatusService.read(input)
  })
export const publicFulfillmentStatus = workspaceTokenAuthAPIForScope(
  "automation",
)
  .route({
    method: "GET",
    path: "/v1/flows/fulfillment-status",
    summary: "Статус исполнения и обязательных частей выдачи",
    tags: ["Flows"],
  })
  .input(statusInput)
  .output(fulfillmentStatusSchema)
  .handler(({ input, context }) => {
    context.resHeaders?.set("Cache-Control", "private, no-store")
    return fulfillmentStatusService.read({
      ...input,
      workspaceId: context.workspace.id,
    })
  })
