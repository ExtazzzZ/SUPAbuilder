import {
  receiptEmailTemplateCandidateSchema,
  receiptEmailTemplateChangeResultSchema,
  receiptEmailTemplateChangeSchema,
  receiptEmailTemplateService,
  receiptEmailTemplateUsageSchema,
} from "@chatbotx.io/business"
import { z } from "zod"
import { possibleErrorsOnMutatingResource } from "@/lib/orpc/orpc-error-helper"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI, workspaceTokenAuthAPIForScope } from "@/orpc"

const usageInput = z.object({
  flowId: z
    .string()
    .regex(/^\d+$/)
    .describe("Source flow id from flows.receiptEmailTemplateCandidates."),
  nodeId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Optional source Email node id from flows.receiptEmailTemplateCandidates.",
    ),
})
const workspace = z.object({ workspaceId: z.string().regex(/^\d+$/) })
const publicAPI = workspaceTokenAuthAPIForScope("automation")
const candidatesOutput = z.object({
  data: z.array(receiptEmailTemplateCandidateSchema),
})
const usagesOutput = z.object({
  data: z.array(receiptEmailTemplateUsageSchema),
})

export const receiptEmailTemplatePublicRouter = {
  receiptEmailTemplateCandidates: publicAPI
    .route({
      method: "GET",
      path: "/v1/flows/receipt-email-templates",
      summary: "List published Email settings templates",
      description:
        "Returns native Email nodes from published same-workspace flow revisions. Use flows.get/updateDraft/publish to edit the source once. The exact flowId/flowVersionId/nodeId triplet feeds flows.changeReceiptEmailTemplate; no draft source is adoptable.",
      tags: ["Flows"],
    })
    .output(candidatesOutput)
    .handler(async ({ context }) => ({
      data: await receiptEmailTemplateService.candidates({
        workspaceId: context.workspace.id,
      }),
    })),
  receiptEmailTemplateUsages: publicAPI
    .route({
      method: "GET",
      path: "/v1/flows/receipt-email-template-usages",
      summary: "List Email settings template usages",
      description:
        "Get source flowId/nodeId from flows.receiptEmailTemplateCandidates. Returns only consumer identities, accepted revision and explicit draft/published state in the same workspace; no graph or client values.",
      tags: ["Flows"],
    })
    .input(usageInput)
    .output(usagesOutput)
    .handler(async ({ input, context }) => ({
      data: await receiptEmailTemplateService.usages({
        ...input,
        workspaceId: context.workspace.id,
      }),
    })),
  changeReceiptEmailTemplate: publicAPI
    .route({
      method: "POST",
      path: "/v1/flows/receipt-email-template-change",
      summary: "Preview, adopt or detach Email settings revision",
      description:
        "Get consumer flowId/nodeId/expectedNode from flows.get and source from flows.receiptEmailTemplateCandidates. Preview returns exact target node and settings diff; explicitly adopt that same source revision in the consumer draft, retaining its prompt override and all technical IDs/routes. expectedNode is compared under the existing draft transaction; stale edits fail. Detach keeps the effective form even when source is unavailable. Published consumers change only with their own flows.publish.",
      tags: ["Flows"],
    })
    .input(receiptEmailTemplateChangeSchema)
    .output(receiptEmailTemplateChangeResultSchema)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ input, context }) =>
      receiptEmailTemplateService.change({
        ...input,
        workspaceId: context.workspace.id,
      }),
    ),
}

export const receiptEmailTemplatePrivateRouter = {
  privateReceiptEmailTemplateCandidates: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows/receipt-email-templates",
      tags: ["Flows"],
    })
    .input(workspace)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(candidatesOutput)
    .handler(async ({ input }) => ({
      data: await receiptEmailTemplateService.candidates(input),
    })),
  privateReceiptEmailTemplateUsages: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows/receipt-email-template-usages",
      tags: ["Flows"],
    })
    .input(usageInput.and(workspace))
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(usagesOutput)
    .handler(async ({ input }) => ({
      data: await receiptEmailTemplateService.usages(input),
    })),
  privateChangeReceiptEmailTemplate: authorizedAPI
    .route({
      method: "POST",
      path: "/workspaces/{workspaceId}/flows/receipt-email-template-change",
      tags: ["Flows"],
    })
    .input(receiptEmailTemplateChangeSchema.and(workspace))
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(receiptEmailTemplateChangeResultSchema)
    .handler(async ({ input }) => receiptEmailTemplateService.change(input)),
}
