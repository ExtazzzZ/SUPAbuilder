import { assertPublicUrl } from "@chatbotx.io/business"
import ky from "ky"
import { signApiPayload } from "./signature"

const DELIVERY_TIMEOUT_MS = 30_000
const TRACE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
export type DeliveryResponse = { messageId?: string }
type Timing = { name: string; duration_ms: number; outcome: string; at: string }
const budgets = new Map<string, number>()

/** Independent guard for callers outside the validated worker environment. */
export function latencyProbeAllowed(envelope: unknown): boolean {
  if (
    process.env.DELIVERY_LATENCY_PROBE !== "true" ||
    process.env.RAILWAY_PROJECT_ID !== "9ce1c13f-74dc-433b-8c7e-d56aedd58e6a" ||
    process.env.RAILWAY_ENVIRONMENT_ID !==
      "3e8b511b-4fc0-4e49-9190-c98b0da86a12"
  ) {
    return false
  }
  const value = envelope as {
    traceId?: unknown
    contact?: { sourceId?: unknown }
  } | null
  if (
    typeof value?.traceId !== "string" ||
    !TRACE_ID_PATTERN.test(value.traceId) ||
    value.contact?.sourceId !==
      "supacrm:be16bc32-75e5-464b-85f6-ba9a562edb6a:34231733"
  ) {
    return false
  }
  return performance.now() < 900_000
}

async function timed<T>(
  name: string,
  spans: Timing[] | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  if (!spans) {
    return execute()
  }
  const started = performance.now()
  const at = new Date().toISOString()
  let outcome = "ok"
  try {
    return await execute()
  } catch (error) {
    outcome = classify(error)
    throw error
  } finally {
    spans.push({ name, duration_ms: performance.now() - started, outcome, at })
  }
}

/** Sign and POST exactly once; DNS/public URL protection and retries are unchanged. */
export const postSignedEnvelope = async (args: {
  callbackUrl: string
  signingSecret: string
  envelope: unknown
  timeoutMs?: number
  retry?: number
  probeContext?: { requestId: string }
}): Promise<DeliveryResponse | null> => {
  const spans: Timing[] | undefined = latencyProbeAllowed(args.envelope)
    ? []
    : undefined
  const started = spans ? performance.now() : 0
  const at = spans ? new Date().toISOString() : ""
  let requestId: string | undefined
  let outcome = "ok"
  try {
    const { traceId, validTrace, rawBody, timestamp, signature } = await timed(
      "callback.preparation",
      spans,
      async () => {
        await assertPublicUrl(args.callbackUrl, "API channel callback URL")
        const traceId = (args.envelope as { traceId?: unknown } | null)?.traceId
        const validTrace =
          typeof traceId === "string" && TRACE_ID_PATTERN.test(traceId)
        const rawBody = JSON.stringify(args.envelope)
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const signature = await signApiPayload(
          args.signingSecret,
          timestamp,
          rawBody,
        )
        return { traceId, validTrace, rawBody, timestamp, signature }
      },
    )
    const deliveryRequestId =
      spans &&
      args.probeContext &&
      TRACE_ID_PATTERN.test(args.probeContext.requestId)
        ? args.probeContext.requestId
        : crypto.randomUUID()
    requestId = deliveryRequestId
    const response = await timed("callback.post", spans, () =>
      ky.post(args.callbackUrl, {
        body: rawBody,
        headers: {
          "Content-Type": "application/json",
          "X-ChatbotX-Signature": `sha256=${signature}`,
          "X-ChatbotX-Timestamp": timestamp,
          "X-ChatbotX-Delivery": deliveryRequestId,
          ...(validTrace ? { "X-Trace-Id": traceId as string } : {}),
        },
        timeout: args.timeoutMs ?? DELIVERY_TIMEOUT_MS,
        ...(args.retry === undefined ? {} : { retry: args.retry }),
      }),
    )
    const text = await timed("callback.response", spans, () => response.text())
    if (!text) {
      return null
    }
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  } catch (error) {
    outcome = classify(error)
    throw error
  } finally {
    if (spans) {
      spans.push({
        name: "callback.total",
        duration_ms: performance.now() - started,
        outcome,
        at,
      })
      const trace = (args.envelope as { traceId: string }).traceId
      const count = takeLatencyBudget(trace, spans.length)
      try {
        if (count) {
          console.info(
            JSON.stringify({
              event: "delivery_latency_probe",
              trace_id: (args.envelope as { traceId: string }).traceId,
              at,
              request_id: requestId,
              event_kind: eventKind(args.envelope),
              timeout_ms: args.timeoutMs ?? DELIVERY_TIMEOUT_MS,
              outcome,
              spans: spans.slice(0, count).map((span) => ({
                ...span,
                parent:
                  span.name === "callback.total" ? null : "callback.total",
              })),
              build: latencyProbeBuild(),
              dropped: spans.length - count,
            }),
          )
        }
      } catch {
        /* Probe export never changes delivery. */
      }
    }
  }
}

export function takeLatencyBudget(traceId: string, count: number): number {
  if (!TRACE_ID_PATTERN.test(traceId) || performance.now() >= 900_000) {
    return 0
  }
  if (!budgets.has(traceId)) {
    if (budgets.size >= 128) {
      return 0
    }
    budgets.set(traceId, 128)
  }
  const left = budgets.get(traceId) ?? 0
  const take = Math.min(left, count)
  budgets.set(traceId, left - take)
  return take
}

function classify(error: unknown): string {
  try {
    const name = (error as { name?: string } | null)?.name
    if (name === "TimeoutError" || name === "AbortError") {
      return "timeout"
    }
    if (name === "HTTPError") {
      return "http_error"
    }
  } catch {
    /* No error text is inspected or exported. */
  }
  return "network_error"
}

export function latencyProbeBuild(): string {
  const build = process.env.RAILWAY_DEPLOYMENT_ID
  return build && TRACE_ID_PATTERN.test(build) ? build : "local"
}

function eventKind(envelope: unknown): string {
  const kind = (envelope as { event?: string }).event
  if (kind === "execution.trace" || kind === "message_created") {
    return kind
  }
  return "other"
}
