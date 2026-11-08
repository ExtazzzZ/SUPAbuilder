import {
  getSupacrmFulfillment,
  sendMessageNodeSchema,
  supacrmFulfillmentCommand,
} from "@chatbotx.io/flow-config"
import { z } from "zod"
import { flowService } from "../flow"
import { flowVersionService } from "../flow-version"
import { checkSsrfSafety } from "../net/ssrf-guard"

export type CrmFulfillmentOrigin = {
  workspaceId: string
  inboxId: string
  contactId: string
  conversationId: string
  flowId: string
  flowVersionId: string
  nodeId: string
  stepId: string
}

export const supacrmFulfillmentService = {
  async scope(input: { workspaceId: string; inboxId: string; flowId: string }) {
    await flowService.findById({
      workspaceId: input.workspaceId,
      id: input.flowId,
    })
    return input
  },
  async origin(
    input: Omit<CrmFulfillmentOrigin, "nodeId"> & {
      marker: string
      portIds: string[]
    },
  ): Promise<CrmFulfillmentOrigin> {
    const version = await flowVersionService.findById({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      versionId: input.flowVersionId,
    })
    const node = version.nodes
      .map((candidate) => sendMessageNodeSchema.safeParse(candidate))
      .flatMap((result) => (result.success ? [result.data] : []))
      .find((candidate) =>
        candidate.data.details.steps.some((step) => step.id === input.stepId),
      )
    if (node?.type !== "sendMessage") {
      throw new Error("fulfillment_origin_invalid")
    }
    const settings = getSupacrmFulfillment(node.data.details)
    if (
      !settings ||
      supacrmFulfillmentCommand(settings) !== input.marker ||
      node.data.details.quickReplies.length !== input.portIds.length ||
      node.data.details.quickReplies.some(
        (port, index) => port.id !== input.portIds[index],
      )
    ) {
      throw new Error("fulfillment_origin_invalid")
    }
    return {
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      flowId: input.flowId,
      flowVersionId: input.flowVersionId,
      nodeId: node.id,
      stepId: input.stepId,
    }
  },
}

export const fulfillmentStatusSchema = z.strictObject({
  fulfillmentRef: z.uuid(),
  purchaseStatus: z.string(),
  deliveryStatus: z.string(),
  nativeStatus: z.enum(["waiting", "completed", "sent", "unknown", "review"]),
  parts: z.array(z.strictObject({ key: z.string(), status: z.string() })),
  errorCode: z.string().optional(),
})
const originSchema = z.strictObject({
  workspaceId: z.string(),
  inboxId: z.string(),
  contactId: z.string(),
  conversationId: z.string(),
  flowId: z.string(),
  flowVersionId: z.string(),
  nodeId: z.string(),
  stepId: z.string(),
})
const internalStatusSchema = z.strictObject({
  status: fulfillmentStatusSchema,
  origin: originSchema,
  registryId: z.uuid(),
  peerId: z.string(),
  blockId: z.string().nullable(),
  terminalEventId: z.string().nullable(),
  outputs: z.array(z.string()).length(3),
})
type StatusInput = {
  workspaceId: string
  flowId: string
  fulfillmentRef: string
}
async function readOwned(input: StatusInput) {
  const configured = process.env.SUPACRM_FULFILLMENT_API_URL
  const key = process.env.SUPACRM_FULFILLMENT_API_KEY
  if (!(configured && key)) {
    throw new Error("fulfillment_status_disabled")
  }
  const url = new URL(configured)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v1/automation/native-fulfillment/status" ||
    (await checkSsrfSafety(url.href)).unsafe
  ) {
    throw new Error("fulfillment_status_configuration_invalid")
  }
  url.searchParams.set("workspace_id", input.workspaceId)
  url.searchParams.set("flow_id", input.flowId)
  url.searchParams.set("fulfillment_ref", input.fulfillmentRef)
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "X-Automation-Key": key },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error("fulfillment_status_unavailable")
  }
  const text = await response.text()
  if (text.length > 16_000) {
    throw new Error("fulfillment_status_invalid")
  }
  const result = internalStatusSchema.parse(JSON.parse(text))
  if (
    result.origin.workspaceId !== input.workspaceId ||
    result.origin.flowId !== input.flowId ||
    result.status.fulfillmentRef !== input.fulfillmentRef
  ) {
    throw new Error("fulfillment_status_scope_invalid")
  }
  return result
}
async function pinnedVersion(result: z.infer<typeof internalStatusSchema>) {
  const origin = result.origin
  const version = await flowVersionService.findById({
    workspaceId: origin.workspaceId,
    flowId: origin.flowId,
    versionId: origin.flowVersionId,
  })
  const node = version.nodes
    .map((candidate) => sendMessageNodeSchema.safeParse(candidate))
    .flatMap((result) => (result.success ? [result.data] : []))
    .find((n) => n.id === origin.nodeId)
  if (
    node?.type !== "sendMessage" ||
    !getSupacrmFulfillment(node.data.details) ||
    node.data.details.steps[0]?.id !== origin.stepId ||
    node.data.details.quickReplies.some(
      (port, index) => result.outputs[index]?.split(":")[2] !== port.id,
    )
  ) {
    throw new Error("fulfillment_pinned_version_unavailable")
  }
  return version
}
export const fulfillmentStatusService = {
  async read(input: StatusInput) {
    const result = await readOwned(input)
    try {
      await pinnedVersion(result)
    } catch {
      return {
        ...result.status,
        nativeStatus: "review" as const,
        errorCode: "fulfillment_pinned_version_unavailable",
      }
    }
    return result.status
  },
  async continuation(
    input: StatusInput & {
      flowVersionId: string
      terminalEventId: string
      blockId: string
      action: string
      sourceEventId?: string
      inboxId: string
      contactId: string
      conversationId: string
      sourceId: string
    },
  ) {
    const result = await readOwned(input)
    const o = result.origin
    if (
      input.sourceEventId !== input.terminalEventId ||
      result.terminalEventId !== input.terminalEventId ||
      result.blockId !== input.blockId ||
      o.flowVersionId !== input.flowVersionId ||
      o.inboxId !== input.inboxId ||
      o.contactId !== input.contactId ||
      o.conversationId !== input.conversationId ||
      input.sourceId !== `supacrm:${result.registryId}:${result.peerId}` ||
      !result.outputs.includes(input.action)
    ) {
      throw new Error("fulfillment_continuation_invalid")
    }
    const native = result.status.nativeStatus
    const terminalIndex =
      (
        { completed: 0, sent: 0, unknown: 1, review: 2 } as Record<
          string,
          number
        >
      )[native] ?? -1
    if (
      terminalIndex < 0 ||
      result.outputs[terminalIndex] !== input.action ||
      result.status.errorCode === "native_run_changed"
    ) {
      throw new Error("fulfillment_continuation_invalid")
    }
    const version = await pinnedVersion(result)
    const port = input.action.split(":")[2]
    if (
      !(
        version.edges as unknown as { source: string; sourceHandle: string }[]
      ).some((edge) => edge.source === o.nodeId && edge.sourceHandle === port)
    ) {
      throw new Error("fulfillment_continuation_edge_missing")
    }
    return version
  },
}
