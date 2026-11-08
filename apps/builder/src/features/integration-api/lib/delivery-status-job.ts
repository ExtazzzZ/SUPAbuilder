import type { enqueueIntegrationJob } from "@chatbotx.io/worker-config"

/** Edge-safe producer options. Повтор POST дедуплицируется на срок retention. */
export async function deliveryStatusJobOptions(
  inboxId: string,
  status: { messageId: string; status: string; timestamp: string },
): Promise<NonNullable<Parameters<typeof enqueueIntegrationJob>[1]>> {
  const tuple = JSON.stringify([
    inboxId,
    status.messageId,
    status.status,
    status.timestamp,
  ])
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(tuple),
  )
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  const jobId = `api-status-${hex}`
  return {
    jobId,
    // Throttle key переживает auto-cleanup общей очереди, в отличие от job row.
    deduplication: { id: jobId, ttl: 604_800_000 },
    attempts: 4,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  }
}
