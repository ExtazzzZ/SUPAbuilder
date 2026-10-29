import { aiSegmentImageDefaultFn } from "@chatbotx.io/flow-config"
import sharp from "sharp"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  aiFindBy: vi.fn(),
  downloadWithByteLimit: vi.fn(),
  env: { HEAVY_MAX_IMAGE_BYTES: 10 * 1024 * 1024 },
  getIntegrationContext: vi.fn(),
  loggerInfo: vi.fn(),
  putObject: vi.fn(),
  readCustomFieldValue: vi.fn(),
  segmentImage: vi.fn(),
}))

vi.mock("@chatbotx.io/ai", () => ({
  aiProviders: { enum: { muse: "muse" } },
  aiTimeouts: { aiTotal: 30_000 },
}))
vi.mock("@chatbotx.io/ai/server", () => ({
  aiIntegrationService: { findBy: mocks.aiFindBy },
}))
// Rasters are described by the mask payload so tests can shape them freely:
// "full" fills the box, "top" fills only the first row.
vi.mock("@chatbotx.io/ai/sam", () => ({
  decodeMaskToRaster: (mask: {
    height: number
    payload: string
    width: number
  }) => {
    const raster = new Uint8Array(mask.width * mask.height)
    if (mask.payload === "full") {
      raster.fill(1)
    } else if (mask.payload === "top") {
      raster.fill(1, 0, mask.width)
    }
    return raster
  },
  segmentImage: mocks.segmentImage,
}))
vi.mock("@chatbotx.io/business", () => ({
  resolveTenantSettings: vi.fn(async () => ({ storageUrl: "https://cdn" })),
}))
vi.mock("@chatbotx.io/business/utils", () => ({
  getPublicFileUrl: (path: string, base: string) => `${base}/${path}`,
}))
vi.mock("../src/env", () => ({ env: mocks.env }))
vi.mock("../src/integration/utils/contact", () => ({
  getIntegrationContext: mocks.getIntegrationContext,
  readCustomFieldValue: mocks.readCustomFieldValue,
}))
vi.mock("../src/heavy/handlers/bounded-download", () => ({
  downloadWithByteLimit: mocks.downloadWithByteLimit,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { error: vi.fn(), info: mocks.loggerInfo, warn: vi.fn() },
}))

const { SEGMENT_MAX_INPUT_PIXELS, SEGMENT_MAX_MASKS, segmentImageOutput } =
  await import("../src/heavy/handlers/segment-image")
const { ExpectedHeavyStepError } = await import("../src/heavy/handlers/errors")

const PNG_KEY_PATTERN = /\.png$/

const conversation = { id: "conv-1", workspaceId: "ws-1", contactId: "c-1" }

type MaskSpec = {
  bottom: number
  confidence?: number
  left: number
  objectId?: string
  payload?: string
  right: number
  top: number
}

function maskRecord(spec: MaskSpec) {
  return {
    kind: "mask",
    objectId: spec.objectId ?? "0",
    identity: `image:${spec.objectId ?? "0"}`,
    order: 1,
    revision: 1,
    bounds: {
      left: spec.left,
      top: spec.top,
      right: spec.right,
      bottom: spec.bottom,
    },
    mask: {
      encoding: "one_bit",
      payload: spec.payload ?? "full",
      width: spec.right - spec.left,
      height: spec.bottom - spec.top,
    },
    ...(spec.confidence === undefined ? {} : { confidence: spec.confidence }),
  }
}

async function solidPng(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer()
}

function makeStep(
  overrides: Parameters<typeof aiSegmentImageDefaultFn>[0] = {},
) {
  return aiSegmentImageDefaultFn({
    id: "step-1",
    inputFieldId: "field-in",
    target: "product box",
    outputFieldId: "field-out",
    ...overrides,
  })
}

function run(
  overrides: Parameters<typeof aiSegmentImageDefaultFn>[0] = {},
  identityHash = "run-a",
) {
  return segmentImageOutput({
    contactInbox: { id: "ci-1" },
    conversation,
    identityHash,
    jobId: "heavy-aiSegmentImage-run-a",
    step: makeStep(overrides),
  } as never)
}

async function uploadedImage(): Promise<{
  alpha: number[]
  channels: number
  height: number
  width: number
}> {
  const [, buffer] = mocks.putObject.mock.calls.at(-1) ?? []
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const alpha: number[] = []
  for (
    let index = info.channels - 1;
    index < data.length;
    index += info.channels
  ) {
    alpha.push(data[index] ?? 0)
  }
  return {
    alpha,
    channels: info.channels,
    height: info.height,
    width: info.width,
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

describe("segmentImageOutput", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.env.HEAVY_MAX_IMAGE_BYTES = 10 * 1024 * 1024
    mocks.aiFindBy.mockResolvedValue({
      auth: { authType: "secretText", secretText: "muse-key" },
    })
    mocks.readCustomFieldValue.mockResolvedValue("https://example.com/in.png")
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await solidPng(4, 4),
    })
    mocks.putObject.mockResolvedValue(undefined)
    mocks.getIntegrationContext.mockResolvedValue({
      storagePrefix: "ws-1",
      uploader: { putObject: mocks.putObject },
    })
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskRecord({ left: 0, top: 0, right: 2, bottom: 2 })],
    })
  })

  test("writes a transparent cutout and uses the fixed Muse key", async () => {
    const result = await run()

    expect(mocks.aiFindBy).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      provider: "muse",
    })
    expect(mocks.segmentImage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "muse-key",
        mimeType: "image/jpeg",
        target: "product box",
      }),
    )
    expect(mocks.putObject).toHaveBeenCalledWith(
      "ws-1/conversations/conv-1/segment-run-a.png",
      expect.any(Buffer),
      { ContentType: "image/png" },
    )
    expect(result).toEqual({
      status: "success",
      outputValues: [
        {
          customFieldId: "field-out",
          value: "https://cdn/ws-1/conversations/conv-1/segment-run-a.png",
        },
      ],
    })

    const image = await uploadedImage()
    expect(image.channels).toBe(4)
    expect(image).toMatchObject({ width: 4, height: 4 })
    // Top-left 2×2 kept opaque, everything else transparent.
    expect(image.alpha).toEqual([
      255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
  })

  test("writes a black/white mask", async () => {
    await run({ outputFormat: "mask" })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    expect((await sharp(buffer).metadata()).channels).toBe(1)
    const { data } = await sharp(buffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data]).toEqual([
      255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
  })

  test("largest keeps the mask with the most pixels, not the largest box", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [
        // Big box, one filled row (4 px).
        maskRecord({
          objectId: "0",
          left: 0,
          top: 0,
          right: 4,
          bottom: 3,
          payload: "top",
        }),
        // Small box, fully filled (1 px)... and a 2×3 box fully filled (6 px).
        maskRecord({ objectId: "1", left: 2, top: 3, right: 3, bottom: 4 }),
        maskRecord({ objectId: "2", left: 0, top: 1, right: 2, bottom: 4 }),
      ],
    })

    await run({ outputFormat: "mask", detailsOutputFieldId: "field-details" })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    const { data } = await sharp(buffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data]).toEqual([
      0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0,
    ])
  })

  test("all combines every mask and reports bounded details", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [
        maskRecord({
          objectId: "0",
          left: 0,
          top: 0,
          right: 1,
          bottom: 1,
          confidence: 0.9,
        }),
        maskRecord({ objectId: "1", left: 3, top: 3, right: 4, bottom: 4 }),
      ],
    })

    const result = await run({
      matchSelection: "all",
      outputFormat: "mask",
      detailsOutputFieldId: "field-details",
    })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    const { data } = await sharp(buffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data]).toEqual([
      255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255,
    ])
    expect(result.status === "success" && result.outputValues[1]).toEqual({
      customFieldId: "field-details",
      value: JSON.stringify({
        count: 2,
        boxes: [
          { left: 0, top: 0, right: 1, bottom: 1, confidence: 0.9 },
          { left: 3, top: 3, right: 4, bottom: 4 },
        ],
        source: { width: 4, height: 4 },
      }),
    })
  })

  test("decodes at most SEGMENT_MAX_MASKS masks, keeping the largest boxes", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await solidPng(40, 40),
    })
    const masks = Array.from({ length: SEGMENT_MAX_MASKS + 5 }, (_, index) =>
      maskRecord({
        objectId: String(index),
        left: 0,
        top: index,
        right: index + 1,
        bottom: index + 1,
      }),
    )
    mocks.segmentImage.mockResolvedValue({ kind: "matched", masks })

    const result = await run({
      matchSelection: "all",
      detailsOutputFieldId: "field-details",
    })

    const details =
      result.status === "success"
        ? JSON.parse(result.outputValues[1]?.value ?? "{}")
        : {}
    expect(details.count).toBe(SEGMENT_MAX_MASKS + 5)
    expect(details.boxes).toHaveLength(SEGMENT_MAX_MASKS)
    // The five smallest boxes (rows 0–4) are dropped.
    expect(details.boxes.map((box: { top: number }) => box.top)).not.toContain(
      4,
    )
  })

  test("returns skip and writes nothing when no object matches", async () => {
    mocks.segmentImage.mockResolvedValue({ kind: "no_match" })

    await expect(run()).resolves.toEqual({ status: "skip" })
    expect(mocks.putObject).not.toHaveBeenCalled()
  })

  test("rejects a mask that does not fit the image", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskRecord({ left: 2, top: 2, right: 6, bottom: 6 })],
    })

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
    expect(mocks.putObject).not.toHaveBeenCalled()
  })

  test("rejects a non-image download", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: Buffer.from("not an image"),
    })

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
    expect(mocks.segmentImage).not.toHaveBeenCalled()
  })

  test("downloads under the byte ceiling", async () => {
    await run()

    expect(mocks.downloadWithByteLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 10 * 1024 * 1024,
        url: "https://example.com/in.png",
      }),
    )
  })

  test("rejects a normalized image over the byte ceiling", async () => {
    mocks.env.HEAVY_MAX_IMAGE_BYTES = 10

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
    expect(mocks.segmentImage).not.toHaveBeenCalled()
  })

  test("rejects an image over the pixel ceiling before decoding", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await solidPng(5001, 5000),
    })

    const error = await rejection(run())
    expect(error).toBeInstanceOf(ExpectedHeavyStepError)
    // The pixel ceiling, not "not an image": the header is read unbounded.
    expect((error as Error).message).toBe(
      `Input image exceeds ${SEGMENT_MAX_INPUT_PIXELS} pixels`,
    )
    expect(mocks.segmentImage).not.toHaveBeenCalled()
  })

  test.each([
    6, 8,
  ])("applies EXIF orientation %i before SAM sees the image", async (orientation) => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await sharp({
        create: { width: 4, height: 2, channels: 3, background: "#fff" },
      })
        .jpeg()
        .withMetadata({ orientation })
        .toBuffer(),
    })
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskRecord({ left: 0, top: 0, right: 2, bottom: 4 })],
    })

    await run()

    const sent = mocks.segmentImage.mock.calls[0]?.[0]
    const metadata = await sharp(sent.image).metadata()
    expect({ width: metadata.width, height: metadata.height }).toEqual({
      width: 2,
      height: 4,
    })
    expect(await uploadedImage()).toMatchObject({ width: 2, height: 4 })
  })

  test("keeps transparency-capable sources as PNG", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    })

    await run()

    expect(mocks.segmentImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "image/png" }),
    )
  })

  test("different runs of the same step write different objects", async () => {
    await run({}, "run-a")
    await run({}, "run-b")

    const keys = mocks.putObject.mock.calls.map(([key]) => key)
    expect(keys).toEqual([
      "ws-1/conversations/conv-1/segment-run-a.png",
      "ws-1/conversations/conv-1/segment-run-b.png",
    ])
  })

  test("rejects an empty source field", async () => {
    mocks.readCustomFieldValue.mockResolvedValue("")

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
  })

  test("rejects a missing Muse integration", async () => {
    mocks.aiFindBy.mockResolvedValue(null)

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
  })

  test("propagates Meta 429 and timeouts for the retry policy", async () => {
    const rateLimited = Object.assign(new Error("rate limited"), {
      retryable: true,
      status: 429,
    })
    mocks.segmentImage.mockRejectedValueOnce(rateLimited)
    expect(await rejection(run())).toBe(rateLimited)

    const timeout = new DOMException("deadline", "AbortError")
    mocks.segmentImage.mockRejectedValueOnce(timeout)
    expect(await rejection(run())).toBe(timeout)
  })

  test("propagates storage failures for the retry policy", async () => {
    const storageError = new Error("S3 unavailable")
    mocks.putObject.mockRejectedValueOnce(storageError)

    expect(await rejection(run())).toBe(storageError)
  })

  test("accepts an image exactly at the pixel ceiling", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await solidPng(5000, 5000),
    })
    mocks.segmentImage.mockResolvedValue({ kind: "no_match" })

    await expect(run()).resolves.toEqual({ status: "skip" })
  })

  test("reports which image check failed", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: Buffer.from("not an image"),
    })

    expect(((await rejection(run())) as Error).message).toBe(
      "Input is not a supported image",
    )
  })

  test.each([
    [
      "webp",
      () =>
        sharp({
          create: { width: 4, height: 4, channels: 3, background: "#f00" },
        })
          .webp()
          .toBuffer(),
      "image/jpeg",
    ],
    [
      "gif",
      () =>
        sharp({
          create: { width: 4, height: 4, channels: 3, background: "#f00" },
        })
          .gif()
          .toBuffer(),
      "image/png",
    ],
    [
      "jpeg",
      () =>
        sharp({
          create: { width: 4, height: 4, channels: 3, background: "#f00" },
        })
          .jpeg()
          .toBuffer(),
      "image/jpeg",
    ],
  ])("accepts %s input and always writes a PNG", async (_format, make, sentAs) => {
    mocks.downloadWithByteLimit.mockResolvedValue({ buffer: await make() })

    await run()

    expect(mocks.segmentImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: sentAs }),
    )
    const [key, , options] = mocks.putObject.mock.calls[0] ?? []
    expect(key).toMatch(PNG_KEY_PATTERN)
    expect(options).toEqual({ ContentType: "image/png" })
    expect(
      (await sharp(mocks.putObject.mock.calls[0]?.[1]).metadata()).format,
    ).toBe("png")
  })

  test("rejects an unsupported but valid image format", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#fff" },
      })
        .tiff()
        .toBuffer(),
    })

    expect(await rejection(run())).toBeInstanceOf(ExpectedHeavyStepError)
  })

  test("sends SAM the exact bytes it later cuts out", async () => {
    await run()

    const sent = mocks.segmentImage.mock.calls[0]?.[0]
    const sentMeta = await sharp(sent.image).metadata()
    const output = await uploadedImage()
    expect({ width: sentMeta.width, height: sentMeta.height }).toEqual({
      width: output.width,
      height: output.height,
    })
  })

  test("keeps the source's own transparency inside the cutout", async () => {
    mocks.downloadWithByteLimit.mockResolvedValue({
      buffer: await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 10, g: 20, b: 30, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    })

    await run()

    const { alpha } = await uploadedImage()
    expect(alpha[0]).toBe(128)
    expect(alpha[5]).toBe(128)
    expect(alpha[2]).toBe(0)
    expect(alpha[15]).toBe(0)
  })

  test("accepts a mask that touches the right and bottom edges", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskRecord({ left: 2, top: 2, right: 4, bottom: 4 })],
    })

    await run({ outputFormat: "mask" })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    const { data } = await sharp(buffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255,
    ])
  })

  test.each([
    ["starts left of the image", { left: -1, top: 0, right: 1, bottom: 1 }, {}],
    [
      "has a raster narrower than its box",
      { left: 0, top: 0, right: 2, bottom: 2 },
      { width: 1 },
    ],
    [
      "has a raster shorter than its box",
      { left: 0, top: 0, right: 2, bottom: 2 },
      { height: 1 },
    ],
  ])("rejects a mask that %s", async (_name, bounds, maskOverride) => {
    const record = maskRecord(bounds)
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [{ ...record, mask: { ...record.mask, ...maskOverride } }],
    })

    expect(((await rejection(run())) as Error).message).toBe(
      "Segmentation mask does not match the image dimensions",
    )
  })

  test("all unions overlapping masks", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [
        maskRecord({ objectId: "0", left: 0, top: 0, right: 3, bottom: 1 }),
        maskRecord({ objectId: "1", left: 1, top: 0, right: 4, bottom: 1 }),
      ],
    })

    await run({ matchSelection: "all", outputFormat: "mask" })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    const { data } = await sharp(buffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data].slice(0, 4)).toEqual([255, 255, 255, 255])
    expect([...data].slice(4).every((value) => value === 0)).toBe(true)
  })

  test("largest keeps the first of equally large masks", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [
        maskRecord({ objectId: "0", left: 0, top: 0, right: 2, bottom: 1 }),
        maskRecord({ objectId: "1", left: 2, top: 3, right: 4, bottom: 4 }),
      ],
    })

    const result = await run({ detailsOutputFieldId: "field-details" })

    const details = JSON.parse(
      result.status === "success" ? (result.outputValues[1]?.value ?? "") : "",
    )
    expect(details.boxes).toEqual([{ left: 0, top: 0, right: 2, bottom: 1 }])
  })

  test("details hold boxes and sizes only, never mask data", async () => {
    const result = await run({ detailsOutputFieldId: "field-details" })

    const value =
      result.status === "success" ? (result.outputValues[1]?.value ?? "") : ""
    expect(Object.keys(JSON.parse(value)).sort()).toEqual([
      "boxes",
      "count",
      "source",
    ])
    expect(value).not.toContain("full")
    expect(value).not.toContain("one_bit")
  })

  test("a retry of the same run writes the same object with the same bytes", async () => {
    await run({}, "run-a")
    await run({}, "run-a")

    const [first, second] = mocks.putObject.mock.calls
    expect(first?.[0]).toBe(second?.[0])
    expect(Buffer.compare(first?.[1], second?.[1])).toBe(0)
  })

  test.each([
    ["an ftp URL", "ftp://example.com/in.png"],
    ["plain text", "a red car"],
    ["a missing value", null],
    ["whitespace", "   "],
  ])("rejects a source field holding %s", async (_name, value) => {
    mocks.readCustomFieldValue.mockResolvedValue(value)

    expect(((await rejection(run())) as Error).message).toBe(
      "Source field has no image URL",
    )
    expect(mocks.downloadWithByteLimit).not.toHaveBeenCalled()
  })

  test("trims the source URL and reads the configured field", async () => {
    mocks.readCustomFieldValue.mockResolvedValue("  http://example.com/a.png  ")

    await run()

    expect(mocks.readCustomFieldValue).toHaveBeenCalledWith({
      contactId: "c-1",
      customFieldId: "field-in",
    })
    expect(mocks.downloadWithByteLimit).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://example.com/a.png" }),
    )
  })

  test("propagates a download rejection (unsafe URL, size, status)", async () => {
    const unsafe = new ExpectedHeavyStepError("Unsafe image URL")
    mocks.downloadWithByteLimit.mockRejectedValueOnce(unsafe)

    expect(await rejection(run())).toBe(unsafe)
    expect(mocks.segmentImage).not.toHaveBeenCalled()
  })

  test("rejects a Muse integration without a usable API key", async () => {
    mocks.aiFindBy.mockResolvedValue({ auth: { authType: "oauth2" } })

    expect(((await rejection(run())) as Error).message).toBe(
      "Muse integration has no API key",
    )
    expect(mocks.downloadWithByteLimit).not.toHaveBeenCalled()
  })

  test("rejects a conversation without an integration context", async () => {
    mocks.getIntegrationContext.mockResolvedValueOnce(null)

    expect(((await rejection(run())) as Error).message).toBe(
      "Integration context not found",
    )
  })

  test("aborts the SAM call at the AI deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      mocks.segmentImage.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            )
          }),
      )
      const pending = rejection(run())
      await vi.waitFor(() => expect(mocks.segmentImage).toHaveBeenCalled())

      await vi.advanceTimersByTimeAsync(30_000)

      expect(await pending).toMatchObject({ name: "AbortError" })
    } finally {
      vi.useRealTimers()
    }
  })

  test("clears the deadline once the run finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      await run()
      const { signal } = mocks.segmentImage.mock.calls[0]?.[0] ?? {}

      await vi.advanceTimersByTimeAsync(60_000)

      expect(signal?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test("logs the run context and match count", async () => {
    await run({ detailsOutputFieldId: "field-details" })

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      {
        contactInboxId: "ci-1",
        conversationId: "conv-1",
        jobId: "heavy-aiSegmentImage-run-a",
        matchSelection: "largest",
        matchedCount: 1,
        outputFormat: "cutout",
        stepId: "step-1",
        workspaceId: "ws-1",
      },
      "[ai-segment-image] Segmented image",
    )
  })
})
