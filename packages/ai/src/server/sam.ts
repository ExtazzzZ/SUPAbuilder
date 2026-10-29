/**
 * SAM 3.1 image segmentation over the Meta Model API (`/v1/responses`).
 *
 * Node/worker only — exported through `@chatbotx.io/ai/sam`, never through
 * `@chatbotx.io/ai/server`, so the parser and stream code stay out of the
 * builder's Edge instrumentation graph (AGENTS.md invariant 25).
 *
 * Protocol sources (meta-models/meta-sam, `@meta-sam/parser@0.1.0`):
 * - Output grammar: https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md
 * - Image request (`input_image` as a base64 data URL):
 *   typescript/examples/api-playground/server/openai-request.ts
 * - Live stream finalizes the text lane with `response.content_part.done` only
 *   and echoes `metadata.mask_encoding`:
 *   typescript/packages/parser/test/fixtures/image-wheel.events.json
 */
import {
  parseImageStream,
  ResponsesStreamError,
  ResponsesStreamSourceError,
  recordsOfKind,
  type SegmentationMaskRecord,
} from "@meta-sam/parser"
import { EventSourceParserStream } from "eventsource-parser/stream"
import ky from "ky"
import { z } from "zod"
import { MUSE_BASE_URL } from "../core/muse"

export type { SegmentationMaskRecord } from "@meta-sam/parser"
export { decodeMaskToRaster } from "@meta-sam/parser"

export const SAM_MODEL = "sam-3.1" as const

// `response.completed` echoes the whole output text, so one SSE event can be
// as large as every mask together. Bounds memory on a misbehaving stream.
export const SAM_MAX_SSE_BUFFER_CHARS = 16_000_000

export type SamSegmentationErrorCode =
  | "http_error"
  | "invalid_response"
  | "malformed_event"
  | "stream_error"
  | "incomplete"
  | "invalid_output"

/**
 * `retryable` and `status` are read by the heavy worker's retry policy
 * (`isRetryableHeavyError`): only Meta 408/429/5xx and transport failures
 * are worth a second paid attempt.
 */
export class SamSegmentationError extends Error {
  readonly code: SamSegmentationErrorCode
  readonly retryable: boolean
  readonly status?: number

  constructor(
    message: string,
    options: {
      cause?: unknown
      code: SamSegmentationErrorCode
      retryable: boolean
      status?: number
    },
  ) {
    super(message, { cause: options.cause })
    this.name = "SamSegmentationError"
    this.code = options.code
    this.retryable = options.retryable
    this.status = options.status
  }
}

export type SegmentImageInput = {
  apiKey: string
  /** The exact bytes the caller will later cut out, so masks align. */
  image: Uint8Array
  mimeType: string
  /** Short concrete noun phrase, e.g. "red car". */
  target: string
  signal: AbortSignal
  /** Test seam; defaults to the global fetch through ky. */
  fetch?: typeof fetch
}

export type SegmentImageResult =
  | { kind: "no_match" }
  | { kind: "matched"; masks: readonly SegmentationMaskRecord[] }

const samEventSchema = z.looseObject({ type: z.string().min(1) })
type SamEvent = z.infer<typeof samEventSchema>

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** UTF-8 decoding that keeps a character split across network chunks. */
function utf8DecoderStream(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder()
  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      if (text) {
        controller.enqueue(text)
      }
    },
    flush(controller) {
      const text = decoder.decode()
      if (text) {
        controller.enqueue(text)
      }
    },
  })
}

/**
 * A broken SSE frame (e.g. one over the buffer bound) is a protocol fault, not
 * a network one: retrying would pay for the same broken response again.
 */
async function readNext(
  reader: ReadableStreamDefaultReader<{ data: string }>,
): Promise<ReadableStreamReadResult<{ data: string }>> {
  try {
    return await reader.read()
  } catch (error) {
    // Matched by name: `eventsource-parser` and its `/stream` entry can load
    // as separate ESM/CJS copies, so `instanceof ParseError` is not reliable.
    if (error instanceof Error && error.name === "ParseError") {
      throw new SamSegmentationError(
        `SAM stream is malformed: ${error.message}`,
        {
          cause: error,
          code: "malformed_event",
          retryable: false,
        },
      )
    }
    throw error
  }
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SamEvent> {
  const reader = body
    .pipeThrough(utf8DecoderStream())
    .pipeThrough(
      new EventSourceParserStream({
        maxBufferSize: SAM_MAX_SSE_BUFFER_CHARS,
        // SSE says unknown fields and bad `retry:` values are ignored, so a
        // new Meta field must not kill the stream. A buffer overflow still
        // errors it regardless of this callback.
        onError: () => undefined,
      }),
    )
    .getReader()

  try {
    while (true) {
      const { done, value } = await readNext(reader)
      if (done) {
        return
      }
      if (value.data === "[DONE]") {
        continue
      }
      let json: unknown
      try {
        json = JSON.parse(value.data)
      } catch (error) {
        throw new SamSegmentationError("SAM stream event is not valid JSON", {
          cause: error,
          code: "malformed_event",
          retryable: false,
        })
      }
      const parsed = samEventSchema.safeParse(json)
      if (!parsed.success) {
        throw new SamSegmentationError("SAM stream event has no type", {
          cause: parsed.error,
          code: "malformed_event",
          retryable: false,
        })
      }
      yield parsed.data
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function toSamError(error: unknown): unknown {
  if (error instanceof SamSegmentationError) {
    return error
  }
  if (error instanceof ResponsesStreamSourceError) {
    // Our own event-gate failures surface wrapped as a source error.
    if (error.cause instanceof SamSegmentationError) {
      return error.cause
    }
    return new SamSegmentationError("SAM stream read failed", {
      cause: error,
      code: "stream_error",
      retryable: true,
    })
  }
  if (error instanceof ResponsesStreamError) {
    return new SamSegmentationError(`SAM stream failed: ${error.message}`, {
      cause: error,
      code: "stream_error",
      retryable: false,
    })
  }
  return error
}

/** Latest complete mask per object; an image has a single frame. */
function latestMasks(
  records: readonly SegmentationMaskRecord[],
): SegmentationMaskRecord[] {
  const byIdentity = new Map<string, SegmentationMaskRecord>()
  for (const record of records) {
    byIdentity.set(record.identity, record)
  }
  return [...byIdentity.values()]
}

export async function segmentImage(
  input: SegmentImageInput,
): Promise<SegmentImageResult> {
  const response = await ky.post(`${MUSE_BASE_URL}/responses`, {
    fetch: input.fetch,
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${input.apiKey}`,
    },
    json: {
      model: SAM_MODEL,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: input.target },
            {
              type: "input_image",
              image_url: `data:${input.mimeType};base64,${Buffer.from(input.image).toString("base64")}`,
            },
          ],
        },
      ],
      metadata: { mask_encoding: "one_bit" },
    },
    retry: { limit: 0 },
    signal: input.signal,
    throwHttpErrors: false,
    // The caller's signal is the deadline; ky's default 10s would cut off a
    // slow first byte.
    timeout: false,
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new SamSegmentationError(
      `SAM request failed with status ${response.status}`,
      {
        code: "http_error",
        retryable: isRetryableStatus(response.status),
        status: response.status,
      },
    )
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!(contentType.includes("text/event-stream") && response.body)) {
    await response.body?.cancel().catch(() => undefined)
    throw new SamSegmentationError(
      `SAM response is not an event stream: ${contentType || "unknown"}`,
      { code: "invalid_response", retryable: false },
    )
  }

  let result: Awaited<ReturnType<typeof parseImageStream>["finalResult"]>
  try {
    result = await parseImageStream(readSseEvents(response.body)).finalResult
  } catch (error) {
    throw toSamError(error)
  }

  if (result.outcome.status !== "completed") {
    throw new SamSegmentationError(
      `SAM stream ended early: ${result.outcome.reason}${result.outcome.detail ? ` (${result.outcome.detail})` : ""}`,
      { code: "incomplete", retryable: false },
    )
  }

  const errorDiagnostic = result.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )
  if (errorDiagnostic) {
    throw new SamSegmentationError(
      `SAM output is malformed: ${errorDiagnostic.code}`,
      { code: "invalid_output", retryable: false },
    )
  }

  const masks = latestMasks(recordsOfKind(result.records, "mask"))
  if (masks.length === 0) {
    return { kind: "no_match" }
  }
  return { kind: "matched", masks }
}
