import { aiProviders, aiTimeouts } from "@chatbotx.io/ai"
import {
  decodeMaskToRaster,
  type SegmentationMaskRecord,
  segmentImage,
} from "@chatbotx.io/ai/sam"
import { aiIntegrationService } from "@chatbotx.io/ai/server"
import { resolveTenantSettings } from "@chatbotx.io/business"
import { getPublicFileUrl } from "@chatbotx.io/business/utils"
import {
  type AISegmentImageSchema,
  getAIGeneratedImagePath,
} from "@chatbotx.io/flow-config"
import { secretTextAuthSchema } from "@chatbotx.io/sdk"
import type {
  HeavyStepOutputValue,
  HeavyStepResultData,
} from "@chatbotx.io/worker-config"
import sharp from "sharp"
import { z } from "zod"
import { env } from "../../env"
import type { HeavyStepComputeProps } from "../../integration/handlers/flow-utils"
import {
  getIntegrationContext,
  readCustomFieldValue,
} from "../../integration/utils/contact"
import { logger } from "../../lib/logger"
import { downloadWithByteLimit } from "./bounded-download"
import { ExpectedHeavyStepError } from "./errors"

const FETCH_IMAGE_TIMEOUT_MS = 30_000
// The heavy worker shares its process with chat/integration work, so the
// decoded bitmap is bounded, not just the downloaded bytes (pixel bombs).
export const SEGMENT_MAX_INPUT_PIXELS = 25_000_000
// `all` combines every match; decoding is bounded to the largest boxes.
export const SEGMENT_MAX_MASKS = 20
// `sharp` format names SAM is sent.
const SEGMENTABLE_IMAGE_FORMATS = new Set(["png", "jpeg", "webp", "gif"])
const OUTPUT_CONTENT_TYPE = "image/png"

const sourceUrlSchema = z.url({ protocol: /^https?$/ })

type NormalizedImage = {
  buffer: Buffer
  height: number
  mimeType: string
  width: number
}

type MaskBox = {
  bottom: number
  confidence?: number
  left: number
  right: number
  top: number
}

export type SegmentImageComputeProps =
  HeavyStepComputeProps<AISegmentImageSchema> & {
    /** Per-run identity hash (see `buildHeavyStepIdentityHash`). */
    identityHash: string
    jobId?: string
  }

async function downloadImage(
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const { buffer } = await downloadWithByteLimit({
    label: "image",
    maxBytes: env.HEAVY_MAX_IMAGE_BYTES,
    signal,
    timeout: FETCH_IMAGE_TIMEOUT_MS,
    url,
  })
  return buffer
}

/**
 * Applies EXIF orientation and re-encodes once. The same bytes go to SAM and
 * into the cutout, so masks always line up with the pixels they cut.
 */
async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  // Check the bytes, not `content-type`: CDNs often serve images as
  // `application/octet-stream`. `metadata()` reads only the header, so the
  // pixel ceiling is checked below with its own message instead of failing
  // here as "not an image".
  const metadata = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch(() => undefined)
  if (!(metadata?.format && SEGMENTABLE_IMAGE_FORMATS.has(metadata.format))) {
    throw new ExpectedHeavyStepError("Input is not a supported image")
  }
  if (
    !(metadata.width && metadata.height) ||
    metadata.width * metadata.height > SEGMENT_MAX_INPUT_PIXELS
  ) {
    throw new ExpectedHeavyStepError(
      `Input image exceeds ${SEGMENT_MAX_INPUT_PIXELS} pixels`,
    )
  }

  const pipeline = sharp(input, {
    limitInputPixels: SEGMENT_MAX_INPUT_PIXELS,
  }).rotate()
  const mimeType = metadata.hasAlpha ? "image/png" : "image/jpeg"
  const { data, info } = await (metadata.hasAlpha
    ? pipeline.png()
    : pipeline.jpeg({ quality: 90 })
  ).toBuffer({ resolveWithObject: true })

  if (data.length > env.HEAVY_MAX_IMAGE_BYTES) {
    throw new ExpectedHeavyStepError(
      `Normalized image too large: ${data.length} bytes`,
    )
  }
  return { buffer: data, height: info.height, mimeType, width: info.width }
}

function boxArea(record: SegmentationMaskRecord): number {
  return (
    (record.bounds.right - record.bounds.left) *
    (record.bounds.bottom - record.bounds.top)
  )
}

/**
 * A mask raster covers its box inside the frame. A raster that does not fit
 * the normalized image means SAM saw different pixels than we will cut.
 */
function assertMaskFitsImage(
  record: SegmentationMaskRecord,
  image: NormalizedImage,
): void {
  const { bounds, mask } = record
  const fits =
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= image.width &&
    bounds.bottom <= image.height &&
    mask.width === bounds.right - bounds.left &&
    mask.height === bounds.bottom - bounds.top
  if (!fits) {
    throw new ExpectedHeavyStepError(
      "Segmentation mask does not match the image dimensions",
    )
  }
}

/** ORs one mask raster into the full-frame 0/255 alpha plane. */
function paintMask(
  alpha: Uint8Array,
  imageWidth: number,
  record: SegmentationMaskRecord,
  raster: Uint8Array,
): void {
  const { bounds, mask } = record
  for (let row = 0; row < mask.height; row += 1) {
    const sourceOffset = row * mask.width
    const targetOffset = (bounds.top + row) * imageWidth + bounds.left
    for (let column = 0; column < mask.width; column += 1) {
      if (raster[sourceOffset + column] === 1) {
        alpha[targetOffset + column] = 255
      }
    }
  }
}

function countPixels(raster: Uint8Array): number {
  let count = 0
  for (const value of raster) {
    count += value
  }
  return count
}

function toBox(record: SegmentationMaskRecord): MaskBox {
  return {
    left: record.bounds.left,
    top: record.bounds.top,
    right: record.bounds.right,
    bottom: record.bounds.bottom,
    ...(record.confidence === undefined
      ? {}
      : { confidence: record.confidence }),
  }
}

function buildAlphaPlane(
  masks: readonly SegmentationMaskRecord[],
  image: NormalizedImage,
  matchSelection: AISegmentImageSchema["matchSelection"],
): { alpha: Uint8Array; selected: SegmentationMaskRecord[] } {
  const alpha = new Uint8Array(image.width * image.height)

  if (matchSelection === "all") {
    for (const record of masks) {
      paintMask(alpha, image.width, record, decodeMaskToRaster(record.mask))
    }
    return { alpha, selected: [...masks] }
  }

  // Decode one at a time and keep only the current best raster.
  let best:
    | { pixels: number; raster: Uint8Array; record: SegmentationMaskRecord }
    | undefined
  for (const record of masks) {
    const raster = decodeMaskToRaster(record.mask)
    const pixels = countPixels(raster)
    if (!best || pixels > best.pixels) {
      best = { pixels, raster, record }
    }
  }
  if (best) {
    paintMask(alpha, image.width, best.record, best.raster)
  }
  return { alpha, selected: best ? [best.record] : [] }
}

async function renderOutput(
  alpha: Uint8Array,
  image: NormalizedImage,
  outputFormat: AISegmentImageSchema["outputFormat"],
): Promise<Buffer> {
  if (outputFormat === "mask") {
    return await sharp(alpha, {
      raw: { width: image.width, height: image.height, channels: 1 },
    })
      .toColourspace("b-w")
      .png()
      .toBuffer()
  }
  // sharp runs `removeAlpha` after `joinChannel` whatever the call order, so
  // the alpha plane is applied on raw RGBA instead. Pixels outside the mask
  // become transparent; inside it the source's own alpha is kept.
  const { data, info } = await sharp(image.buffer, {
    limitInputPixels: SEGMENT_MAX_INPUT_PIXELS,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    if (alpha[pixel] === 0) {
      data[pixel * info.channels + 3] = 0
    }
  }
  return await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer()
}

async function resolveMuseApiKey(workspaceId: string): Promise<string> {
  const aiConfig = await aiIntegrationService.findBy({
    workspaceId,
    provider: aiProviders.enum.muse,
  })
  if (!aiConfig) {
    throw new ExpectedHeavyStepError("Muse integration not found")
  }
  const auth = secretTextAuthSchema.safeParse(aiConfig.auth)
  if (!auth.success) {
    throw new ExpectedHeavyStepError("Muse integration has no API key")
  }
  return auth.data.secretText
}

export async function segmentImageOutput({
  contactInbox,
  conversation,
  identityHash,
  jobId,
  step,
}: SegmentImageComputeProps): Promise<HeavyStepResultData> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), aiTimeouts.aiTotal)
  const logContext = {
    contactInboxId: contactInbox.id,
    conversationId: conversation.id,
    jobId,
    matchSelection: step.matchSelection,
    outputFormat: step.outputFormat,
    stepId: step.id,
    workspaceId: conversation.workspaceId,
  }

  try {
    const ctx = await getIntegrationContext({
      workspaceId: conversation.workspaceId,
      contactId: conversation.contactId,
      contactInbox,
    })
    if (!ctx) {
      throw new ExpectedHeavyStepError("Integration context not found")
    }

    const sourceUrl = sourceUrlSchema.safeParse(
      (
        await readCustomFieldValue({
          contactId: conversation.contactId,
          customFieldId: step.inputFieldId,
        })
      )?.trim(),
    )
    if (!sourceUrl.success) {
      throw new ExpectedHeavyStepError("Source field has no image URL")
    }

    const apiKey = await resolveMuseApiKey(conversation.workspaceId)
    const image = await normalizeImage(
      await downloadImage(sourceUrl.data, controller.signal),
    )

    const segmentation = await segmentImage({
      apiKey,
      image: image.buffer,
      mimeType: image.mimeType,
      signal: controller.signal,
      target: step.target,
    })
    if (segmentation.kind === "no_match") {
      logger.info(
        { ...logContext, matchedCount: 0 },
        "[ai-segment-image] No object matched",
      )
      return { status: "skip" }
    }

    for (const record of segmentation.masks) {
      assertMaskFitsImage(record, image)
    }
    const masks = [...segmentation.masks]
      .sort((a, b) => boxArea(b) - boxArea(a))
      .slice(0, SEGMENT_MAX_MASKS)

    const { alpha, selected } = buildAlphaPlane(
      masks,
      image,
      step.matchSelection,
    )
    const output = await renderOutput(alpha, image, step.outputFormat)

    const storagePath = getAIGeneratedImagePath({
      storagePrefix: ctx.storagePrefix,
      fileName: `segment-${identityHash}.png`,
      conversationId: conversation.id,
    })
    await ctx.uploader.putObject(storagePath, output, {
      ContentType: OUTPUT_CONTENT_TYPE,
    })
    const { storageUrl } = await resolveTenantSettings({
      workspaceId: conversation.workspaceId,
    })

    const outputValues: HeavyStepOutputValue[] = [
      {
        customFieldId: step.outputFieldId,
        value: getPublicFileUrl(storagePath, storageUrl),
      },
    ]
    if (step.detailsOutputFieldId) {
      outputValues.push({
        customFieldId: step.detailsOutputFieldId,
        value: JSON.stringify({
          count: segmentation.masks.length,
          boxes: selected.map(toBox),
          source: { width: image.width, height: image.height },
        }),
      })
    }

    logger.info(
      { ...logContext, matchedCount: segmentation.masks.length },
      "[ai-segment-image] Segmented image",
    )
    return { status: "success", outputValues }
  } finally {
    clearTimeout(timeoutId)
  }
}
