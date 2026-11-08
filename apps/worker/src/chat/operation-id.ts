import { createHash } from "node:crypto"

const digest = (parts: unknown[]) =>
  `supacrm-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`

/** Stable across BullMQ retries and restarts; creation time distinguishes reused IDs. */
export const createChatOperationId = (job: {
  id?: string
  timestamp: number
}) => {
  if (!job.id) {
    throw new Error("Outbound API flow job requires a durable queue ID")
  }
  return digest(["chat", job.id, job.timestamp])
}

/** Includes node visit counters so intentional loops may send identical content. */
export const createFlowOperationId = (props: {
  flowExecutionKey?: string
  conversation: { id: string }
  flowVersion: { id: string }
  step: { id: string }
  nodeVisits?: Record<string, number>
}): string | undefined => {
  if (!props.flowExecutionKey) {
    return
  }
  return digest([
    "flow",
    props.flowExecutionKey,
    props.conversation.id,
    props.flowVersion.id,
    props.step.id,
    Object.entries(props.nodeVisits ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  ])
}
