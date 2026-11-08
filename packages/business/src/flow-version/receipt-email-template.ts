import { and, db, eq } from "@chatbotx.io/database/client"
import { flowVersionModel } from "@chatbotx.io/database/schema"
import {
  applyReceiptEmailTemplate,
  detachReceiptEmailTemplate,
  getSupacrmForm,
  type ReceiptEmailTemplateSource,
  receiptEmailContentKey,
  receiptEmailOverridesSchema,
  receiptEmailTemplateSourceSchema,
  type SupacrmForm,
  sendMessageNodeSchema,
} from "@chatbotx.io/flow-config"
import { z } from "zod"
import { notFoundException, validationException } from "../errors"
import { supacrmSourceBindingService } from "../supacrm-source-binding/service"

const id = z.string().regex(/^\d+$/)
export const receiptEmailTemplateChangeSchema = z.object({
  flowId: id.describe("Consumer flow id from flows.get or flows.list."),
  nodeId: id.describe("Consumer Email node id from flows.get."),
  action: z
    .enum(["preview", "adopt", "detach"])
    .describe(
      "Preview settings diff, explicitly adopt the selected revision, or detach while retaining the current effective form.",
    ),
  source: receiptEmailTemplateSourceSchema
    .optional()
    .describe(
      "Exact published source triplet from flows.receiptEmailTemplateCandidates; omitted to retain the accepted source.",
    ),
  overrides: receiptEmailOverridesSchema
    .optional()
    .describe(
      "Optional local prompt only; omit to retain the accepted override, or pass {} to use the source question.",
    ),
  expectedNode: z
    .record(z.string(), z.unknown())
    .describe(
      "Exact consumer node read from flows.get before preview/adoption. Stale content is rejected atomically.",
    ),
  // UI uses this additional guard to avoid discarding local edits during adoption.
  expectedGraph: z
    .object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) })
    .optional()
    .describe(
      "Optional full current draft graph from flows.get, used by the canvas to reject unrelated unsaved changes.",
    ),
})
export const receiptEmailTemplateCandidateSchema =
  receiptEmailTemplateSourceSchema.extend({
    label: z.string(),
    flowName: z.string(),
    publishedAt: z.string(),
    isLatest: z.boolean(),
    versionNumber: z.number(),
  })
export const receiptEmailTemplateUsageSchema = z.object({
  consumerFlowId: id,
  consumerVersionId: id,
  isDraft: z.boolean(),
  nodeId: id,
  acceptedVersionId: id,
  flowName: z.string(),
  nodeLabel: z.string(),
})
export const receiptEmailTemplateChangeResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("unavailable") }),
    z.object({
      status: z.literal("ready"),
      node: sendMessageNodeSchema,
      changes: z.array(
        z.object({
          field: z.string(),
          before: z.union([z.string(), z.boolean()]),
          after: z.union([z.string(), z.boolean()]),
        }),
      ),
    }),
  ],
)
type Change = z.infer<typeof receiptEmailTemplateChangeSchema>

class ReceiptEmailTemplateService {
  async candidates(input: { workspaceId: string }) {
    const rows = await db.query.flowVersionModel.findMany({
      where: { workspaceId: input.workspaceId, isDraft: false },
      orderBy: { id: "asc" },
    })
    const flows = await db.query.flowModel.findMany({
      where: { workspaceId: input.workspaceId },
      columns: { id: true, name: true },
    })
    const names = new Map(flows.map((flow) => [flow.id, flow.name]))
    const numbers = new Map<string, number>()
    const numbered = rows.map((row) => {
      const versionNumber = (numbers.get(row.flowId) ?? 0) + 1
      numbers.set(row.flowId, versionNumber)
      return { row, versionNumber }
    })
    return numbered.flatMap(({ row, versionNumber }) =>
      row.nodes.flatMap((value) => {
        const parsed = sendMessageNodeSchema.safeParse(value)
        if (!(parsed.success && getSupacrmForm(parsed.data.data.details))) {
          return []
        }
        return [
          {
            kind: "receiptEmail" as const,
            flowId: row.flowId,
            flowVersionId: row.id,
            nodeId: parsed.data.id,
            label: parsed.data.data.name,
            flowName: names.get(row.flowId) ?? "",
            publishedAt: row.createdAt.toISOString(),
            isLatest: row.isLatest,
            versionNumber,
          },
        ]
      }),
    )
  }

  async usages(input: {
    workspaceId: string
    flowId: string
    nodeId?: string
  }) {
    // Return identities only. Current drafts and all immutable published revisions stay distinguishable.
    const rows = await db.query.flowVersionModel.findMany({
      where: { workspaceId: input.workspaceId },
    })
    const flows = await db.query.flowModel.findMany({
      where: { workspaceId: input.workspaceId },
      columns: { id: true, name: true },
    })
    const names = new Map(flows.map((flow) => [flow.id, flow.name]))
    return rows.flatMap((row) =>
      row.nodes.flatMap((value) => {
        const node = sendMessageNodeSchema.safeParse(value)
        const ref = node.success
          ? node.data.data.details.supacrmFormTemplate?.source
          : undefined
        return ref?.flowId === input.flowId &&
          (!input.nodeId || ref.nodeId === input.nodeId)
          ? [
              {
                consumerFlowId: row.flowId,
                consumerVersionId: row.id,
                isDraft: row.isDraft,
                nodeId: value.id,
                acceptedVersionId: ref.flowVersionId,
                flowName: names.get(row.flowId) ?? "",
                nodeLabel: node.success ? node.data.data.name : "",
              },
            ]
          : []
      }),
    )
  }

  async change(input: Change & { workspaceId: string }) {
    const request = receiptEmailTemplateChangeSchema.parse(input)
    return await supacrmSourceBindingService.withLegacyFlow(
      {
        workspaceId: input.workspaceId,
        flowId: request.flowId,
        operation: "updateDraft",
      },
      async (tx) => {
        const draft = await tx.query.flowVersionModel.findFirst({
          where: {
            flowId: request.flowId,
            workspaceId: input.workspaceId,
            isDraft: true,
          },
        })
        if (!draft) {
          throw notFoundException("Черновик не найден")
        }
        const index = draft.nodes.findIndex(
          (node) => node.id === request.nodeId,
        )
        const current = draft.nodes[index]
        if (
          !current ||
          receiptEmailContentKey(current) !==
            receiptEmailContentKey(request.expectedNode) ||
          (request.expectedGraph &&
            receiptEmailContentKey({
              nodes: draft.nodes,
              edges: draft.edges,
            }) !== receiptEmailContentKey(request.expectedGraph))
        ) {
          throw validationException(
            "expectedNode",
            "Черновик изменён. Обновите предпросмотр.",
          )
        }
        const parsed = sendMessageNodeSchema.safeParse(current)
        if (!(parsed.success && getSupacrmForm(parsed.data.data.details))) {
          throw validationException("nodeId", "Требуется поле Email")
        }
        const old = parsed.data
        let node = old
        if (request.action === "detach") {
          node = detachReceiptEmailTemplate(old)
        } else {
          const source: ReceiptEmailTemplateSource | undefined =
            request.source ?? old.data.details.supacrmFormTemplate?.source
          if (!source) {
            throw validationException(
              "source",
              "Выберите опубликованное поле Email",
            )
          }
          const version = await tx.query.flowVersionModel.findFirst({
            where: {
              id: source.flowVersionId,
              flowId: source.flowId,
              workspaceId: input.workspaceId,
              isDraft: false,
            },
          })
          const sourceNode = version?.nodes.find(
            (item) => item.id === source.nodeId,
          )
          const sourceParsed = sendMessageNodeSchema.safeParse(sourceNode)
          if (
            !version ||
            version.workspaceId !== input.workspaceId ||
            version.flowId !== source.flowId ||
            version.id !== source.flowVersionId ||
            version.isDraft ||
            !sourceParsed.success ||
            !getSupacrmForm(sourceParsed.data.data.details)
          ) {
            if (request.action === "preview") {
              return { status: "unavailable" as const }
            }
            throw validationException("source", "Источник недоступен")
          }
          node = applyReceiptEmailTemplate(old, {
            source,
            snapshot: getSupacrmForm(sourceParsed.data.data.details),
            overrides:
              request.overrides ??
              old.data.details.supacrmFormTemplate?.overrides ??
              {},
          })
        }
        const before = getSupacrmForm(old.data.details) as SupacrmForm
        const after = getSupacrmForm(node.data.details) as SupacrmForm
        const changes = (Object.keys(before) as (keyof SupacrmForm)[]).flatMap(
          (field) =>
            before[field] === after[field]
              ? []
              : [{ field, before: before[field], after: after[field] }],
        )
        if (request.action !== "preview") {
          const nodes = draft.nodes.map((value, nodeIndex) =>
            nodeIndex === index ? node : value,
          )
          // The existing guard holds Flow FOR UPDATE, serializing every native draft writer.
          await tx
            .update(flowVersionModel)
            .set({ nodes })
            .where(
              and(
                eq(flowVersionModel.id, draft.id),
                eq(flowVersionModel.workspaceId, input.workspaceId),
                eq(flowVersionModel.isDraft, true),
              ),
            )
        }
        return { status: "ready" as const, node, changes }
      },
    )
  }
}
export const receiptEmailTemplateService = new ReceiptEmailTemplateService()
