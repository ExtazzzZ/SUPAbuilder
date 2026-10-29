import { aiSegmentImageDefaultFn } from "@chatbotx.io/flow-config"
import sharp from "sharp"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Same handler as `segment-image-handler.test.ts`, but the masks go through
 * the real `@meta-sam/parser` decoder, so raster placement is proven against
 * genuine SAM payloads instead of a stub.
 */
const mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  segmentImage: vi.fn(),
}))

vi.mock("@chatbotx.io/ai", () => ({
  aiProviders: { enum: { muse: "muse" } },
  aiTimeouts: { aiTotal: 30_000 },
}))
vi.mock("@chatbotx.io/ai/server", () => ({
  aiIntegrationService: {
    findBy: vi.fn(async () => ({
      auth: { authType: "secretText", secretText: "muse-key" },
    })),
  },
}))
vi.mock("@chatbotx.io/ai/sam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/ai/sam")>()),
  segmentImage: mocks.segmentImage,
}))
vi.mock("@chatbotx.io/business", () => ({
  resolveTenantSettings: vi.fn(async () => ({ storageUrl: "https://cdn" })),
}))
vi.mock("@chatbotx.io/business/utils", () => ({
  getPublicFileUrl: (path: string, base: string) => `${base}/${path}`,
}))
vi.mock("../src/env", () => ({
  env: { HEAVY_MAX_IMAGE_BYTES: 10 * 1024 * 1024 },
}))
vi.mock("../src/integration/utils/contact", () => ({
  getIntegrationContext: vi.fn(async () => ({
    storagePrefix: "ws-1",
    uploader: { putObject: mocks.putObject },
  })),
  readCustomFieldValue: vi.fn(async () => "https://example.com/in.png"),
}))
vi.mock("../src/heavy/handlers/bounded-download", () => ({
  downloadWithByteLimit: vi.fn(async () => ({
    buffer: await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer(),
  })),
}))
vi.mock("../src/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const { segmentImageOutput } = await import(
  "../src/heavy/handlers/segment-image"
)

// A verified 5×5 one_bit mask from the SAM protocol conformance corpus.
const PAYLOAD = "!!!!!(QO(0lu8?"
const RASTER = [
  1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1,
]

const maskAt = (objectId: string, left: number, top: number) => ({
  kind: "mask",
  objectId,
  identity: `image:${objectId}`,
  order: 1,
  revision: 1,
  bounds: { left, top, right: left + 5, bottom: top + 5 },
  mask: { encoding: "one_bit", payload: PAYLOAD, width: 5, height: 5 },
})

/** The expected 8×8 plane with RASTER placed at (left, top). */
function expectedPlane(placements: [number, number][]): number[] {
  const plane = new Array(64).fill(0)
  for (const [left, top] of placements) {
    RASTER.forEach((value, index) => {
      if (value === 1) {
        plane[(top + Math.floor(index / 5)) * 8 + left + (index % 5)] = 255
      }
    })
  }
  return plane
}

async function maskPlane(): Promise<number[]> {
  const [, buffer] = mocks.putObject.mock.calls.at(-1) ?? []
  const { data } = await sharp(buffer)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true })
  return [...data]
}

const run = (overrides: Parameters<typeof aiSegmentImageDefaultFn>[0]) =>
  segmentImageOutput({
    contactInbox: { id: "ci-1" },
    conversation: { id: "conv-1", workspaceId: "ws-1", contactId: "c-1" },
    identityHash: "real",
    step: aiSegmentImageDefaultFn({
      id: "1",
      inputFieldId: "field-in",
      target: "wheel",
      outputFieldId: "field-out",
      outputFormat: "mask",
      ...overrides,
    }),
  } as never)

describe("segmentImageOutput with real SAM masks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.putObject.mockResolvedValue(undefined)
  })

  test("places a decoded raster at its box", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskAt("0", 2, 1)],
    })

    await run({})

    expect(await maskPlane()).toEqual(expectedPlane([[2, 1]]))
  })

  test("all combines decoded rasters at their own boxes", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskAt("0", 0, 0), maskAt("1", 3, 3)],
    })

    await run({ matchSelection: "all" })

    expect(await maskPlane()).toEqual(
      expectedPlane([
        [0, 0],
        [3, 3],
      ]),
    )
  })

  test("a cutout keeps exactly the decoded pixels opaque", async () => {
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [maskAt("0", 1, 2)],
    })

    await run({ outputFormat: "cutout" })

    const [, buffer] = mocks.putObject.mock.calls[0] ?? []
    const { data, info } = await sharp(buffer)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const alpha = Array.from(
      { length: 64 },
      (_, pixel) => data[pixel * info.channels + 3],
    )
    expect(info.channels).toBe(4)
    expect(alpha).toEqual(expectedPlane([[1, 2]]))
  })

  test("a corrupt payload fails the run instead of writing a broken image", async () => {
    const record = maskAt("0", 0, 0)
    mocks.segmentImage.mockResolvedValue({
      kind: "matched",
      masks: [
        { ...record, mask: { ...record.mask, payload: "!!!!!(QO(0lu8" } },
      ],
    })

    await expect(run({})).rejects.toThrow()
    expect(mocks.putObject).not.toHaveBeenCalled()
  })
})
