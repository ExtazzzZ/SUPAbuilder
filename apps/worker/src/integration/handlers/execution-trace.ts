import { createHash } from "node:crypto"
import type { BaseStepSchema, FlowNode } from "@chatbotx.io/flow-config"
import { postSignedEnvelope } from "@chatbotx.io/integration-api/lib/delivery"
import { apiAuthSchema } from "@chatbotx.io/integration-api/schema"
import { logger } from "../../lib/logger"
import { resolveIntegrationContextFromContactInbox } from "../../services/integrations"
import type { ExecuteMultipleStepsProps } from "./flow-utils"

/** Diagnostics must never alter step results, routing or retry behavior. */
export async function executeTracedFlowStep<T>(
  props: ExecuteMultipleStepsProps,
  step: BaseStepSchema,
  execute: () => Promise<T>,
): Promise<T> {
  if (
    props.contactInbox.channel !== "api" ||
    !props.contactInbox.sourceId?.startsWith("supacrm:")
  ) {
    return execute()
  }
  const startedAt = new Date().toISOString()
  const start = performance.now()
  let status = "error"
  try {
    const result = await execute()
    status = (result as { status?: string } | undefined)?.status ?? "success"
    return result
  } finally {
    const durationMs = Math.max(
      0,
      Math.round((performance.now() - start) * 1000) / 1000,
    )
    try {
      const { ctx } = await resolveIntegrationContextFromContactInbox({
        workspaceId: props.conversation.workspaceId,
        contactInbox: props.contactInbox,
      })
      const auth = apiAuthSchema.parse(ctx.auth)
      if (auth.callbackUrl) {
        const nodes = props.flowVersion.nodes as unknown as FlowNode[]
        const owner = nodes.find((entry) =>
          containsExecutionTarget(entry.data, props.targetId, step.id),
        )
        const nodeId =
          props.targetNodeId ||
          (props.targetType === "node" ? props.targetId : undefined) ||
          owner?.id ||
          props.targetId ||
          step.id
        const node = nodes.find((entry) => entry.id === nodeId)
        const operationId = `flow-trace-${createHash("sha256")
          .update(
            JSON.stringify({
              executionKey: props.flowExecutionKey,
              startedAt,
              status: normalizeTraceStatus(status),
              contactInboxId: props.contactInbox.id,
              targetType: props.targetType,
              targetId: props.targetId,
              flowId: props.flowVersion.flowId,
              nodeId,
              nodeVisits: props.nodeVisits,
              stepId: step.id,
            }),
          )
          .digest("hex")}`
        await postSignedEnvelope({
          callbackUrl: auth.callbackUrl,
          signingSecret: auth.signingSecret,
          // Keep inline diagnostics bounded; never retry or delay routing for seconds.
          timeoutMs: 500,
          retry: 0,
          envelope: {
            event: "execution.trace",
            ...(props.crmNavigation?.traceId
              ? { traceId: props.crmNavigation.traceId }
              : {}),
            operationId,
            contact: { sourceId: props.contactInbox.sourceId },
            trace: {
              flowId: props.flowVersion.flowId,
              nodeId,
              nodeName: node?.data.name ?? nodeId,
              stepId: step.id,
              stepType: step.stepType,
              startedAt,
              durationMs,
              status: normalizeTraceStatus(status),
            },
          },
        })
      }
    } catch {
      // Transport errors may include credentials, URLs or response bodies.
      logger.warn(
        { reason: "execution_trace_delivery_failed" },
        "Flow execution trace delivery failed",
      )
    }
  }
}

function normalizeTraceStatus(status: string) {
  if (status === "wait" || status === "retry") {
    return "waiting"
  }
  if (status === "skip" || status === "error") {
    return status
  }
  return "success"
}

/** Published flow details are JSON; locate nested buttons, quick replies and steps. */
function containsExecutionTarget(
  value: unknown,
  targetId: string | undefined,
  stepId: string,
): boolean {
  if (!value || typeof value !== "object") {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsExecutionTarget(entry, targetId, stepId),
    )
  }
  const record = value as Record<string, unknown>
  if (record.id === stepId || (targetId && record.id === targetId)) {
    return true
  }
  return Object.values(record).some((entry) =>
    containsExecutionTarget(entry, targetId, stepId),
  )
}
