import { readFileSync } from "node:fs"
import { describe, expect, test, vi } from "vitest"
import { MUSE_BASE_URL } from "../src/core/muse"
import {
  decodeMaskToRaster,
  SAM_MAX_SSE_BUFFER_CHARS,
  SAM_MODEL,
  SamSegmentationError,
  segmentImage,
} from "../src/server/sam"

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/sam/${name}`, import.meta.url), "utf8")

const encoder = new TextEncoder()

/** Splits the body into byte chunks of `size`, so any boundary is exercised. */
function chunkedBody(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

function sseResponse(text: string, chunkSize = 4096): Response {
  return new Response(chunkedBody(text, chunkSize), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    status: 200,
  })
}

function sseEvents(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
}

const lane = { item_id: "msg-1", output_index: 0, content_index: 0 }

function run(
  response: Response | ((request: Request) => Promise<Response>),
  signal = new AbortController().signal,
) {
  const fetchMock = vi.fn(
    typeof response === "function"
      ? response
      : async (_request: Request) => response,
  )
  return {
    fetchMock,
    result: segmentImage({
      apiKey: "muse-key",
      fetch: fetchMock,
      image: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      signal,
      target: "wheel",
    }),
  }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected a rejection")
}

describe("segmentImage", () => {
  test("sends a streaming sam-3.1 request with the image as a data URL", async () => {
    let request: Request | undefined
    let body: unknown
    const { result } = run(async (input) => {
      request = input
      body = await input.clone().json()
      return sseResponse(fixture("success.sse"))
    })
    await result

    expect(request?.url).toBe(`${MUSE_BASE_URL}/responses`)
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("authorization")).toBe("Bearer muse-key")
    expect(request?.headers.get("accept")).toBe("text/event-stream")
    expect(body).toEqual({
      model: SAM_MODEL,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "wheel" },
            { type: "input_image", image_url: "data:image/png;base64,AQID" },
          ],
        },
      ],
      metadata: { mask_encoding: "one_bit" },
    })
  })

  test("parses the captured live stream finalized by content_part.done", async () => {
    const { result } = run(sseResponse(fixture("success.sse")))
    const output = await result

    expect(output.kind).toBe("matched")
    if (output.kind !== "matched") {
      return
    }
    expect(output.masks).toHaveLength(4)
    const [first] = output.masks
    expect(first?.objectId).toBe("0")
    expect(first?.bounds).toEqual({
      left: 445,
      top: 626,
      right: 676,
      bottom: 850,
    })
    expect(first?.mask.encoding).toBe("one_bit")
    if (first) {
      expect(decodeMaskToRaster(first.mask)).toHaveLength(
        first.mask.width * first.mask.height,
      )
    }
  })

  test.each([
    1, 3, 7, 64,
  ])("parses the same result when the body is split every %i bytes", async (chunkSize) => {
    const { result } = run(sseResponse(fixture("success.sse"), chunkSize))
    const output = await result

    expect(output.kind).toBe("matched")
    expect(output.kind === "matched" && output.masks).toHaveLength(4)
  })

  test("splits inside a multi-byte character without corrupting JSON", async () => {
    const text =
      "<0f>0<|box;x1=0;y1=0;x2=4;y2=4;w=20;h=10|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n"
    const body = sseEvents([
      { type: "response.created", note: "xe đạp" },
      { type: "response.output_text.delta", ...lane, delta: text },
      {
        type: "response.content_part.done",
        ...lane,
        part: { type: "output_text", text },
      },
      { type: "response.completed" },
    ])
    const { result } = run(sseResponse(body, 1))

    expect((await result).kind).toBe("matched")
  })

  test("maps a completed stream without masks to no_match", async () => {
    const { result } = run(sseResponse(fixture("no-match.sse")))

    expect(await result).toEqual({ kind: "no_match" })
  })

  test.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("maps HTTP %i to a typed error (retryable=%s)", async (status, retryable) => {
    const { result } = run(new Response("nope", { status }))
    const error = await rejection(result)

    expect(error).toBeInstanceOf(SamSegmentationError)
    expect(error).toMatchObject({ code: "http_error", retryable, status })
  })

  test("rejects a non-SSE success response", async () => {
    const { result } = run(
      new Response("{}", {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    )

    expect(await rejection(result)).toMatchObject({
      code: "invalid_response",
      retryable: false,
    })
  })

  test("rejects malformed event JSON", async () => {
    const { result } = run(
      sseResponse("event: response.created\ndata: {not json\n\n"),
    )

    expect(await rejection(result)).toMatchObject({
      code: "malformed_event",
      retryable: false,
    })
  })

  test("rejects an event without a type", async () => {
    const { result } = run(sseResponse('data: {"delta":"x"}\n\n'))

    expect(await rejection(result)).toMatchObject({
      code: "malformed_event",
      retryable: false,
    })
  })

  test("maps response.failed to a non-retryable stream error", async () => {
    const { result } = run(sseResponse(fixture("error.sse")))

    expect(await rejection(result)).toMatchObject({
      code: "stream_error",
      retryable: false,
    })
  })

  test("maps an SSE error event to a non-retryable stream error", async () => {
    const { result } = run(
      sseResponse(sseEvents([{ type: "error", message: "overloaded" }])),
    )

    expect(await rejection(result)).toMatchObject({
      code: "stream_error",
      retryable: false,
    })
  })

  test("rejects a stream that ends before a terminal event", async () => {
    const { result } = run(sseResponse(fixture("early-eof.sse")))

    expect(await rejection(result)).toMatchObject({
      code: "incomplete",
      retryable: false,
    })
  })

  test("rejects output with a malformed record", async () => {
    const text = "<0f>0<|box;x1=0;y1=0|>\n"
    const { result } = run(
      sseResponse(
        sseEvents([
          { type: "response.output_text.delta", ...lane, delta: text },
          {
            type: "response.content_part.done",
            ...lane,
            part: { type: "output_text", text },
          },
          { type: "response.completed" },
        ]),
      ),
    )

    expect(await rejection(result)).toMatchObject({
      code: "invalid_output",
      retryable: false,
    })
  })

  test("propagates an abort before the response arrives", async () => {
    const controller = new AbortController()
    const { result } = run(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) {
            reject(request.signal.reason)
            return
          }
          request.signal.addEventListener("abort", () =>
            reject(request.signal.reason),
          )
        }),
      controller.signal,
    )
    controller.abort(new DOMException("deadline", "AbortError"))

    expect(await rejection(result)).toMatchObject({ name: "AbortError" })
  })

  test("treats a body read failure mid-stream as retryable", async () => {
    const bytes = encoder.encode(fixture("early-eof.sse"))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.error(new TypeError("socket hang up"))
      },
    })
    const { result } = run(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    )

    expect(await rejection(result)).toMatchObject({
      code: "stream_error",
      retryable: true,
    })
  })
})

/** One output-text lane finalized like the live API, then completed. */
function liveStream(text: string, extra: Record<string, unknown>[] = []) {
  return sseEvents([
    { type: "response.created" },
    { type: "response.output_text.delta", ...lane, delta: text },
    {
      type: "response.content_part.done",
      ...lane,
      part: { type: "output_text", text },
    },
    ...extra,
    { type: "response.completed" },
  ])
}

// A verified 5×5 one_bit mask from the SAM protocol conformance corpus.
const FIVE_BY_FIVE = "!!!!!(QO(0lu8?"
const FIVE_BY_FIVE_RASTER = [
  1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1,
]
const box = (id: number, extra = "") =>
  `${id}<|box;x1=0;y1=0;x2=4;y2=4;w=20;h=10${extra}|><|mask;x=0;y=0;data=5,5,${FIVE_BY_FIVE}|>`

describe("segmentImage stream edge cases", () => {
  test("decodes a lossless mask from a captured live response", async () => {
    const { result } = run(sseResponse(fixture("lossless.sse"), 5))
    const output = await result

    expect(output.kind).toBe("matched")
    const [mask] = output.kind === "matched" ? output.masks : []
    expect(mask?.mask).toMatchObject({
      encoding: "lossless",
      width: 11,
      height: 11,
    })
    expect(mask?.bounds).toEqual({
      left: 513,
      top: 371,
      right: 524,
      bottom: 382,
    })
    if (mask) {
      expect(decodeMaskToRaster(mask.mask)).toHaveLength(121)
    }
  })

  test("decodes a one_bit raster to the exact row-major pixels", async () => {
    const { result } = run(sseResponse(liveStream(`<0f>${box(0)}\n`)))
    const output = await result

    const [mask] = output.kind === "matched" ? output.masks : []
    expect(mask && [...decodeMaskToRaster(mask.mask)]).toEqual(
      FIVE_BY_FIVE_RASTER,
    )
  })

  test("keeps every object of a multi-object line, with confidence", async () => {
    const { result } = run(
      sseResponse(
        liveStream(`<0f>${box(0, ";c=0.75")},${box(3)},${box(7, ";c=1")}\n`),
      ),
    )
    const output = await result

    const masks = output.kind === "matched" ? output.masks : []
    expect(masks.map((mask) => mask.objectId)).toEqual(["0", "3", "7"])
    expect(masks.map((mask) => mask.confidence)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  test("keeps only the latest mask when the same object is sent twice", async () => {
    const second = `0<|box;x1=1;y1=1;x2=5;y2=5;w=20;h=10|><|mask;x=0;y=0;data=5,5,${FIVE_BY_FIVE}|>`
    const { result } = run(
      sseResponse(liveStream(`<0f>${box(0)}\n<0f>${second}\n`)),
    )
    const output = await result

    const masks = output.kind === "matched" ? output.masks : []
    expect(masks).toHaveLength(1)
    expect(masks[0]?.revision).toBe(2)
    expect(masks[0]?.bounds.left).toBe(1)
  })

  test("still matches when the parser only reports warnings", async () => {
    const { result } = run(
      sseResponse(liveStream(`<0f>${box(0, ";future=1")}\n`)),
    )

    expect((await result).kind).toBe("matched")
  })

  test("treats a completed prose-only answer as no match", async () => {
    const { result } = run(sseResponse(liveStream("No wheel here.\n")))

    expect(await result).toEqual({ kind: "no_match" })
  })

  test("ignores a [DONE] sentinel, comments, unknown SSE fields and events without a name", async () => {
    const text = `<0f>${box(0)}\n`
    const body = [
      ": keep-alive\n\n",
      "retry: soon\n\n",
      "x-meta-trace: abc\n\n",
      `data: ${JSON.stringify({ type: "response.output_text.delta", ...lane, delta: text })}\n\n`,
      `data: ${JSON.stringify({ type: "response.content_part.done", ...lane, part: { type: "output_text", text } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")
    const { result } = run(sseResponse(body, 2))

    expect((await result).kind).toBe("matched")
  })

  test("skips a [DONE] sentinel that arrives before the terminal event", async () => {
    const text = `<0f>${box(0)}\n`
    const body = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", ...lane, delta: text })}\n\n`,
      `data: ${JSON.stringify({ type: "response.content_part.done", ...lane, part: { type: "output_text", text } })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
    ].join("")
    const { result } = run(sseResponse(body))

    expect((await result).kind).toBe("matched")
  })

  test("survives a body that ends inside a multi-byte character", async () => {
    const bytes = new Uint8Array([
      ...encoder.encode(liveStream(`<0f>${box(0)}\n`)),
      // First byte of "é" with no continuation byte.
      0xc3,
    ])
    const { result } = run(
      new Response(new Blob([bytes]).stream(), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    )

    expect((await result).kind).toBe("matched")
  })

  test("flushes a dangling byte at EOF and still reports the early end", async () => {
    const bytes = new Uint8Array([
      ...encoder.encode(fixture("early-eof.sse")),
      0xc3,
    ])
    const { result } = run(
      new Response(new Blob([bytes]).stream(), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    )

    expect(await rejection(result)).toMatchObject({ code: "incomplete" })
  })

  test("ignores unrelated Responses events between deltas", async () => {
    const text = `<0f>${box(0)}\n`
    const { result } = run(
      sseResponse(
        sseEvents([
          { type: "response.in_progress" },
          { type: "response.output_item.added", item: {} },
          { type: "response.content_part.added", ...lane, part: {} },
          { type: "response.output_text.delta", ...lane, delta: text },
          { type: "response.reasoning_text.delta", delta: "hm" },
          {
            type: "response.content_part.done",
            ...lane,
            part: { type: "output_text", text },
          },
          { type: "response.output_item.done", item: {} },
          { type: "response.completed" },
        ]),
      ),
    )

    expect((await result).kind).toBe("matched")
  })

  test("rejects an SSE frame over the buffer bound without retrying", async () => {
    const huge = `data: ${"a".repeat(SAM_MAX_SSE_BUFFER_CHARS + 10)}`
    const { result } = run(sseResponse(huge, 1_000_000))

    expect(await rejection(result)).toMatchObject({
      code: "malformed_event",
      retryable: false,
    })
  })

  test("maps a refusal to a non-retryable stream error", async () => {
    const { result } = run(
      sseResponse(
        sseEvents([
          {
            type: "response.content_part.done",
            ...lane,
            part: { type: "refusal", refusal: "Not allowed" },
          },
          { type: "response.completed" },
        ]),
      ),
    )

    expect(await rejection(result)).toMatchObject({
      code: "stream_error",
      retryable: false,
    })
  })

  test("maps response.incomplete to an incomplete error with its reason", async () => {
    const text = `<0f>${box(0)}\n`
    const { result } = run(
      sseResponse(
        sseEvents([
          { type: "response.output_text.delta", ...lane, delta: text },
          {
            type: "response.content_part.done",
            ...lane,
            part: { type: "output_text", text },
          },
          {
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          },
        ]),
      ),
    )
    const error = await rejection(result)

    expect(error).toMatchObject({ code: "incomplete", retryable: false })
    expect(String((error as Error).message)).toContain("max_output_tokens")
  })

  test("rejects a completed response that never finalized its text lane", async () => {
    const { result } = run(
      sseResponse(
        sseEvents([
          { type: "response.output_text.delta", ...lane, delta: "<0f>" },
          { type: "response.completed" },
        ]),
      ),
    )

    expect(await rejection(result)).toMatchObject({
      code: "stream_error",
      retryable: false,
    })
  })

  test("rejects finalized text that conflicts with the deltas", async () => {
    const { result } = run(
      sseResponse(
        sseEvents([
          { type: "response.output_text.delta", ...lane, delta: "<0f>a\n" },
          {
            type: "response.content_part.done",
            ...lane,
            part: { type: "output_text", text: "<0f>b\n" },
          },
          { type: "response.completed" },
        ]),
      ),
    )

    expect(await rejection(result)).toMatchObject({ code: "stream_error" })
  })

  test("rejects a success response without content-type", async () => {
    const { result } = run(new Response(chunkedBody("data: {}\n\n", 64)))

    expect(await rejection(result)).toMatchObject({ code: "invalid_response" })
  })

  test("rejects an event-stream response without a body", async () => {
    const { result } = run(
      new Response(null, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    )

    expect(await rejection(result)).toMatchObject({ code: "invalid_response" })
  })

  test("releases the body of a failed HTTP response", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(encoder.encode("rate limited"))
      },
    })
    const { result } = run(new Response(body, { status: 429 }))
    await rejection(result)

    expect(cancel).toHaveBeenCalled()
  })

  test("leaves a transport failure untyped so the retry policy retries it", async () => {
    const network = new TypeError("fetch failed")
    const { result } = run(() => Promise.reject(network))
    const error = await rejection(result)

    expect(error).not.toBeInstanceOf(SamSegmentationError)
    expect(error).toMatchObject({ cause: network })
  })

  test("aborts the request through the caller's signal", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { result } = run((request) => {
      seen = request.signal
      controller.abort(new DOMException("deadline", "AbortError"))
      return Promise.reject(request.signal.reason)
    }, controller.signal)
    await rejection(result)

    expect(seen?.aborted).toBe(true)
  })
})
