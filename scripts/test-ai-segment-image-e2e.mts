/**
 * End-to-end check of the AI Segment Image step (SAM 3.1 over the Meta Model
 * API) against a real workspace and its own Muse integration, on an isolated
 * Webchat/contact fixture, so no real customer is messaged.
 *
 * Groups (all run by default unless noted):
 *   client   `segmentImage` against the live API: request shape, streamed
 *            masks, no match, invalid key. `--record-dir` saves the raw SSE
 *            responses as test fixtures.
 *   handler  the heavy handler with real storage: cutout/mask × largest/all,
 *            details JSON, pixel-level checks of the uploaded PNG, EXIF
 *            rotation, replacing the source field, per-run object keys.
 *   errors   unsafe/broken/non-image URLs, pixel ceiling, empty source field.
 *   flow     (--with-workers) a real published flow run through the
 *            integration and heavy queues: Found / Not found / Failed routing.
 *            Needs `pnpm --filter worker dev` (integration + heavy) running.
 *   api      (--api-url + --api-token) public Flow API: create/publish a flow
 *            holding the step, reject an invalid one, the step in the spec.
 *
 * Usage:
 *   pnpm exec tsx scripts/test-ai-segment-image-e2e.mts \
 *     --workspace-id 91652163796992 --apply [--env .env] \
 *     [--only client,handler,errors,flow,api] \
 *     [--image-url https://… --target "red apple"] \
 *     [--record-dir packages/ai/__tests__/fixtures/sam/live] \
 *     [--with-workers] \
 *     [--api-url http://localhost:3123/api --api-token cbx_…] [--keep-flows]
 *
 * Without --image-url the source photo is generated with the Muse image model
 * (one extra paid call). The workspace must already have Muse connected
 * (Settings → Integrations). Fixtures are named "Segment QA …" and reused;
 * each run creates a new contact and uploads under `segment-qa/<run>/`.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const args = process.argv.slice(2)
const getOption = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const workspaceId = getOption("--workspace-id")
const envFile = getOption("--env") ?? ".env"
const apply = args.includes("--apply")
const withWorkers = args.includes("--with-workers")
const keepFlows = args.includes("--keep-flows")
const only = getOption("--only")?.split(",")
const imageUrlOption = getOption("--image-url")
const target = getOption("--target") ?? "apple"
const recordDir = getOption("--record-dir")
const apiUrl = getOption("--api-url")?.replace(/\/$/, "")
const apiToken = getOption("--api-token")
const prefix = "Segment QA"
const webchatName = `${prefix} | runtime Webchat`
// Something that cannot be in a fruit still life.
const NO_MATCH_TARGET = "giraffe"
const IMAGE_MODEL = "muse-image-1.0"
const SOURCE_PROMPT =
  "Three red apples and one green pear on a plain white table, studio product photo, soft shadows"
const TEST_TIMEOUT_MS = 240_000
const FLOW_TIMEOUT_MS = 420_000
const POLL_MS = 3000
// The handler's expected-error messages.
const UNSAFE_URL_ERROR = /unsafe image url/i
const MISSING_OBJECT_ERROR = /image download failed with status 4\d\d/i
const NOT_IMAGE_ERROR = /not a supported image/i
const PIXEL_CEILING_ERROR = /exceeds \d+ pixels/
const EMPTY_SOURCE_ERROR = /no image url/i

if (!workspaceId) {
  throw new Error("Missing --workspace-id <workspaceId>.")
}
if (!apply) {
  console.log("Dry run: pass --apply to run against the workspace.")
  process.exit(0)
}

process.loadEnvFile(envFile)
process.env.SKIP_ENV_CHECK = "true"

// `sharp` is a worker dependency, not a root one.
const workerRequire = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
)
const sharp = workerRequire(
  "sharp",
) as typeof import("../apps/worker/node_modules/sharp")["default"]

await import("../packages/business/src/audit/index.ts")
const { withAuditContext } = await import(
  "../packages/business/src/audit/context.ts"
)
const [
  { contactCustomFieldService },
  { contactService },
  { conversationService },
  { customFieldService },
  { flowService },
  { integrationWebchatService },
  { workspaceMemberService },
  { resolveTenantSettings },
  { getPublicFileUrl },
  { aiIntegrationService },
  { SAM_MODEL, SamSegmentationError, decodeMaskToRaster, segmentImage },
  { secretTextAuthSchema },
  { createId },
  flowConfig,
  { IntegrationJobAction, integrationQueue },
  { getIntegrationContext },
  { generateImageOutput },
  { SEGMENT_MAX_INPUT_PIXELS, segmentImageOutput },
  { ExpectedHeavyStepError, isRetryableHeavyError },
] = await Promise.all([
  import("../packages/business/src/contact-custom-field/service.ts"),
  import("../packages/business/src/contact/service.ts"),
  import("../packages/business/src/conversation/service.ts"),
  import("../packages/business/src/custom-field/service.ts"),
  import("../packages/business/src/flow/service.ts"),
  import("../packages/business/src/integration-webchat/service.ts"),
  import("../packages/business/src/workspace-member/service.ts"),
  import("../packages/business/src/platform/settings.ts"),
  import("../packages/business/src/utils.ts"),
  import("../packages/ai/src/server/index.ts"),
  import("../packages/ai/src/server/sam.ts"),
  import("../packages/sdk/src/index.ts"),
  import("../packages/utils/src/id.ts"),
  import("../packages/flow-config/src/index.ts"),
  import("../packages/worker-config/src/queues/integration/index.ts"),
  import("../apps/worker/src/integration/utils/contact.ts"),
  import("../apps/worker/src/heavy/handlers/generate-image.ts"),
  import("../apps/worker/src/heavy/handlers/segment-image.ts"),
  import("../apps/worker/src/heavy/handlers/errors.ts"),
])
const {
  FieldOperationType,
  aiSegmentImageDefaultFn,
  performActionNodeDefaultFn,
  setCustomFieldStepDefaultFn,
} = flowConfig
type SegmentStep = ReturnType<typeof aiSegmentImageDefaultFn>

const ownerId = await workspaceMemberService.findOwnerUserIdByWorkspaceId({
  workspaceId,
})
if (!ownerId) {
  throw new Error(`Workspace ${workspaceId} has no owner.`)
}

type Result = {
  group: string
  test: string
  status: "passed" | "failed" | "skipped"
  ms: number
  note: string
}
const results: Result[] = []

class SkipTest extends Error {}

const withTimeout = <T,>(promise: Promise<T>, label: string, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ])

const groupEnabled = (group: string) => !only || only.includes(group)

/** Runs one test; a failure is recorded and the run continues. */
const runTest = async (
  group: string,
  test: string,
  fn: () => Promise<string>,
  timeoutMs = TEST_TIMEOUT_MS,
) => {
  if (!groupEnabled(group)) {
    return
  }
  const startedAt = performance.now()
  let result: Result
  try {
    const note = await withTimeout(fn(), test, timeoutMs)
    result = { group, test, status: "passed", ms: 0, note }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    result = {
      group,
      test,
      status: error instanceof SkipTest ? "skipped" : "failed",
      ms: 0,
      note,
    }
  }
  result.ms = Math.round(performance.now() - startedAt)
  results.push(result)
  console.log(
    `[${result.status}] ${group} | ${test} (${result.ms}ms) — ${result.note}`,
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const preview = (text: string | null | undefined, max = 140) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const download = async (url: string) => {
  const response = await fetch(url)
  assert(response.ok, `GET ${url} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

type ImageStats = {
  format: string
  channels: number
  width: number
  height: number
  /** Opaque pixels for a cutout, white pixels for a mask. */
  selected: number
  /** Pixel values seen on the selection plane. */
  values: Set<number>
}

/** Reads an uploaded result PNG and measures its selection plane. */
const inspectResult = async (
  url: string,
  outputFormat: SegmentStep["outputFormat"],
): Promise<ImageStats> => {
  const buffer = await download(url)
  const meta = await sharp(buffer).metadata()
  assert(meta.format === "png", `${url} is ${meta.format}, not png`)
  assert(meta.width && meta.height, `${url} has no dimensions`)
  const { data, info } =
    outputFormat === "mask"
      ? await sharp(buffer)
          .toColourspace("b-w")
          .raw()
          .toBuffer({ resolveWithObject: true })
      : await sharp(buffer).ensureAlpha().raw().toBuffer({
          resolveWithObject: true,
        })
  const step = info.channels
  const offset = outputFormat === "mask" ? 0 : 3
  let selected = 0
  const values = new Set<number>()
  for (let index = offset; index < data.length; index += step) {
    const value = data[index] ?? 0
    values.add(value)
    if (value > 0) {
      selected += 1
    }
  }
  return {
    format: meta.format,
    channels: meta.channels ?? 0,
    width: meta.width,
    height: meta.height,
    selected,
    values,
  }
}

const share = (stats: ImageStats) =>
  `${((stats.selected / (stats.width * stats.height)) * 100).toFixed(1)}%`

const audit = <T,>(fn: () => Promise<T>) =>
  withAuditContext({ userId: ownerId, workspaceId, source: "segment-qa" }, fn)

const createdFlowIds: string[] = []

try {
  const integration = await aiIntegrationService.findBy({
    workspaceId,
    provider: "muse",
  })
  if (!integration) {
    throw new Error(
      `Workspace ${workspaceId} has no Muse integration. Connect it in Settings → Integrations first.`,
    )
  }
  const auth = secretTextAuthSchema.safeParse(integration.auth)
  if (!auth.success) {
    throw new Error("The Muse integration has no API key.")
  }
  const apiKey = auth.data.secretText

  // ── Fixture ────────────────────────────────────────────────────────────
  const fixture = await audit(async () => {
    const existingWebchat = await integrationWebchatService
      .list({ workspaceId, page: 1, perPage: 100 })
      .then((result) =>
        result.data.find((webchat) => webchat.name === webchatName),
      )
    const webchat =
      existingWebchat ??
      (await integrationWebchatService
        .createWithWorkspace({
          workspaceId,
          createdBy: ownerId,
          workspaceName: "unused",
          data: {
            name: webchatName,
            auth: {},
            enable: true,
            authorizedDomains: [],
            conversationStarters: [],
            persistentMenus: [],
            brandColor: "#2563eb",
            hideHeader: false,
            showLogo: true,
            hideMessageInput: false,
            customCss: null,
          },
        })
        .then(({ webchatId }) =>
          integrationWebchatService.findByIdForWorkspace({
            id: webchatId,
            workspaceId,
          }),
        ))

    const field = async (
      key: string,
      type: "shortText" | "longText" = "shortText",
    ) => {
      const name = `${prefix} | ${key}`
      const existing = await customFieldService.findBy({
        where: { workspaceId, name },
      })
      return (
        existing ??
        (await customFieldService.create({
          workspaceId,
          data: {
            name,
            type,
            description:
              "Fixture for the AI Segment Image e2e script; safe to delete.",
          },
        }))
      ).id
    }
    const fields = {
      source: await field("source image"),
      output: await field("output image"),
      details: await field("details", "longText"),
      replaced: await field("replaced image"),
      route: await field("route"),
      generated: await field("generated source"),
    }

    if (!webchat) {
      throw new Error("Fixture Webchat was not created.")
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { contact, contactInbox } = await contactService.createWithInbox({
      workspaceId,
      input: {
        email: `segment-qa+${runId}@invalid.test`,
        firstName: "Segment QA",
        lastName: runId,
        gender: "unknown",
        channel: "webchat",
        inboxId: webchat.inboxId,
      },
    })
    const conversation = await conversationService.findDMByContact({
      workspaceId,
      contactId: contact.id,
    })
    if (!conversation) {
      throw new Error("Fixture conversation was not created.")
    }
    return { webchat, fields, contact, contactInbox, conversation, runId }
  })

  const { fields, contact, contactInbox, conversation } = fixture
  const readField = (customFieldId: string) =>
    contactCustomFieldService.findValue({
      contactId: contact.id,
      customFieldId,
    })
  const setField = (customFieldId: string, value: string) =>
    audit(() =>
      contactCustomFieldService.setValueForContact({
        workspaceId,
        contactId: contact.id,
        customFieldId,
        value,
      }),
    )

  const { storageUrl } = await resolveTenantSettings({ workspaceId })
  const uploadFixture = async (
    fileName: string,
    body: Buffer,
    contentType: string,
  ) => {
    const ctx = await getIntegrationContext({
      workspaceId,
      contactId: contact.id,
      contactInbox,
    })
    assert(ctx, "integration context not found")
    const objectPath = `${ctx.storagePrefix}/segment-qa/${fixture.runId}/${fileName}`
    await ctx.uploader.putObject(objectPath, body, { ContentType: contentType })
    return getPublicFileUrl(objectPath, storageUrl)
  }

  // ── Source photo ───────────────────────────────────────────────────────
  const sourceUrl =
    imageUrlOption ??
    (await generateImageOutput({
      conversation,
      contactInbox,
      step: {
        id: createId(),
        stepType: "aiGenerateImage",
        provider: "muse",
        model: IMAGE_MODEL,
        prompt: SOURCE_PROMPT,
        size: "1536x1024",
        quality: "auto",
        outputFieldId: fields.generated,
      } as never,
    }))
  const sourceBuffer = await download(sourceUrl)
  const sourceMeta = await sharp(sourceBuffer).metadata()
  assert(sourceMeta.width && sourceMeta.height, "source has no dimensions")
  console.log(
    `Source: ${sourceUrl} (${sourceMeta.format} ${sourceMeta.width}x${sourceMeta.height}), target "${target}"`,
  )
  await setField(fields.source, sourceUrl)

  /** The same normalized JPEG the handler sends, for client-level calls. */
  const clientImage = await sharp(sourceBuffer)
    .rotate()
    .jpeg({ quality: 90 })
    .toBuffer()

  const segmentStep = (overrides: Partial<SegmentStep> = {}): SegmentStep =>
    aiSegmentImageDefaultFn({
      id: createId(),
      inputFieldId: fields.source,
      target,
      outputFieldId: fields.output,
      ...overrides,
    })

  let runSeq = 0
  const runHandler = (
    step: SegmentStep,
    identityHash = `${fixture.runId}-${runSeq++}`,
  ) =>
    audit(() =>
      segmentImageOutput({
        contactInbox,
        conversation,
        identityHash,
        jobId: `segment-qa-${identityHash}`,
        step,
      }),
    )

  // ── Client (live API) ──────────────────────────────────────────────────
  const recordingFetch =
    (name: string): typeof fetch =>
    async (input, init) => {
      const response = await fetch(input, init)
      if (!(recordDir && response.body)) {
        return response
      }
      const [forClient, forDisk] = response.body.tee()
      new Response(forDisk)
        .text()
        .then((text) => {
          mkdirSync(recordDir, { recursive: true })
          writeFileSync(path.join(recordDir, `${name}.sse`), text)
          console.log(`  recorded ${path.join(recordDir, `${name}.sse`)}`)
        })
        .catch((error: unknown) =>
          console.warn(`  could not record ${name}: ${String(error)}`),
        )
      return new Response(forClient, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      })
    }

  const callClient = (
    targetPhrase: string,
    options: { key?: string; record?: string } = {},
  ) =>
    segmentImage({
      apiKey: options.key ?? apiKey,
      image: clientImage,
      mimeType: "image/jpeg",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      target: targetPhrase,
      fetch: options.record ? recordingFetch(options.record) : undefined,
    })

  await runTest("client", `"${target}" streams complete masks`, async () => {
    const result = await callClient(target, { record: "live-success" })
    assert(result.kind === "matched", `expected matches, got ${result.kind}`)
    const meta = await sharp(clientImage).metadata()
    for (const record of result.masks) {
      const { bounds, mask } = record
      assert(
        bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= (meta.width ?? 0) &&
          bounds.bottom <= (meta.height ?? 0),
        `object ${record.objectId} box ${JSON.stringify(bounds)} is outside ${meta.width}x${meta.height}`,
      )
      assert(
        mask.width === bounds.right - bounds.left &&
          mask.height === bounds.bottom - bounds.top,
        `object ${record.objectId} raster ${mask.width}x${mask.height} does not match its box`,
      )
      const raster = decodeMaskToRaster(mask)
      assert(
        raster.some((value) => value === 1),
        `object ${record.objectId} has an empty mask`,
      )
    }
    return `${result.masks.length} object(s), encodings ${[...new Set(result.masks.map((m) => m.mask.encoding))].join(",")}, model ${SAM_MODEL}`
  })

  await runTest(
    "client",
    `"${NO_MATCH_TARGET}" is a completed no-match`,
    async () => {
      const result = await callClient(NO_MATCH_TARGET, {
        record: "live-no-match",
      })
      assert(
        result.kind === "no_match",
        `expected no_match, got ${result.kind === "matched" ? `${result.masks.length} mask(s)` : result.kind}`,
      )
      return "no masks"
    },
  )

  await runTest("client", "Invalid key is a non-retryable 401", async () => {
    try {
      await callClient(target, {
        key: "segment-qa-invalid-key",
        record: "live-invalid-key",
      })
    } catch (error) {
      assert(
        error instanceof SamSegmentationError,
        `unexpected error: ${String(error)}`,
      )
      assert(
        error.status === 401 || error.status === 403,
        `status ${error.status}`,
      )
      assert(!isRetryableHeavyError(error), "an auth failure would be retried")
      return `${error.status} ${error.code}`
    }
    throw new Error("call with an invalid key succeeded")
  })

  // ── Handler (real storage) ─────────────────────────────────────────────
  const outputs = new Map<string, ImageStats>()
  const cases = [
    { outputFormat: "cutout", matchSelection: "largest" },
    { outputFormat: "cutout", matchSelection: "all" },
    { outputFormat: "mask", matchSelection: "largest" },
    { outputFormat: "mask", matchSelection: "all" },
  ] as const
  for (const { outputFormat, matchSelection } of cases) {
    await runTest(
      "handler",
      `${outputFormat} × ${matchSelection} writes a valid PNG`,
      async () => {
        const result = await runHandler(
          segmentStep({
            outputFormat,
            matchSelection,
            detailsOutputFieldId: fields.details,
          }),
        )
        assert(result.status === "success", `got ${result.status}`)
        const [image, details] = result.outputValues
        assert(image?.customFieldId === fields.output, "image output missing")
        assert(details?.customFieldId === fields.details, "details missing")

        const stats = await inspectResult(image.value, outputFormat)
        assert(
          stats.width === sourceMeta.width &&
            stats.height === sourceMeta.height,
          `output ${stats.width}x${stats.height} ≠ source ${sourceMeta.width}x${sourceMeta.height}`,
        )
        assert(
          stats.selected > 0 && stats.selected < stats.width * stats.height,
          `selection covers ${share(stats)} of the image`,
        )
        if (outputFormat === "mask") {
          assert(stats.channels === 1, `mask has ${stats.channels} channels`)
          assert(
            [...stats.values].every((value) => value === 0 || value === 255),
            `mask has grey values ${[...stats.values].slice(0, 5).join(",")}`,
          )
        } else {
          assert(stats.channels === 4, `cutout has ${stats.channels} channels`)
          assert(stats.values.has(0), "cutout has no transparent pixel")
        }

        const parsed = JSON.parse(details.value) as {
          count: number
          boxes: { left: number; top: number; right: number; bottom: number }[]
          source: { width: number; height: number }
        }
        assert(parsed.count >= 1, `count ${parsed.count}`)
        assert(
          parsed.source.width === stats.width &&
            parsed.source.height === stats.height,
          `details source ${JSON.stringify(parsed.source)}`,
        )
        assert(
          matchSelection === "largest"
            ? parsed.boxes.length === 1
            : parsed.boxes.length === Math.min(parsed.count, 20),
          `${parsed.boxes.length} box(es) for ${parsed.count} match(es)`,
        )
        assert(
          details.value.length < 10_000,
          `details are ${details.value.length} chars`,
        )
        outputs.set(`${outputFormat}-${matchSelection}`, stats)
        return `${share(stats)} selected, ${parsed.count} match(es), ${image.value}`
      },
    )
  }

  await runTest("handler", "all covers at least the largest match", () => {
    for (const format of ["cutout", "mask"] as const) {
      const largest = outputs.get(`${format}-largest`)
      const all = outputs.get(`${format}-all`)
      if (!(largest && all)) {
        throw new SkipTest(`${format} outputs missing`)
      }
      assert(
        all.selected >= largest.selected,
        `${format}: all ${all.selected}px < largest ${largest.selected}px`,
      )
    }
    return Promise.resolve("cutout and mask both consistent")
  })

  await runTest("handler", "cutout and mask select the same pixels", () => {
    const cutout = outputs.get("cutout-largest")
    const mask = outputs.get("mask-largest")
    if (!(cutout && mask)) {
      throw new SkipTest("outputs missing")
    }
    // Two separate SAM calls on the same bytes; allow a small drift.
    const drift = Math.abs(cutout.selected - mask.selected) / mask.selected
    assert(
      drift < 0.02,
      `cutout ${cutout.selected}px vs mask ${mask.selected}px`,
    )
    return Promise.resolve(`drift ${(drift * 100).toFixed(2)}%`)
  })

  await runTest(
    "handler",
    "No match routes skip and writes nothing",
    async () => {
      const result = await runHandler(segmentStep({ target: NO_MATCH_TARGET }))
      assert(result.status === "skip", `got ${result.status}`)
      return "skip"
    },
  )

  await runTest(
    "handler",
    "EXIF orientation is applied before SAM",
    async () => {
      // Stored sideways with orientation 6: displayed it is portrait.
      const sideways = await sharp(sourceBuffer)
        .rotate(-90)
        .jpeg({ quality: 90 })
        .withMetadata({ orientation: 6 })
        .toBuffer()
      const raw = await sharp(sideways).metadata()
      const url = await uploadFixture("exif-6.jpg", sideways, "image/jpeg")
      await setField(fields.source, url)
      try {
        const result = await runHandler(segmentStep({ outputFormat: "mask" }))
        assert(result.status === "success", `got ${result.status}`)
        const stats = await inspectResult(
          result.outputValues[0]?.value ?? "",
          "mask",
        )
        assert(
          stats.width === raw.height && stats.height === raw.width,
          `output ${stats.width}x${stats.height}, stored ${raw.width}x${raw.height}`,
        )
        assert(stats.selected > 0, "empty mask after rotation")
        return `stored ${raw.width}x${raw.height} → output ${stats.width}x${stats.height}, ${share(stats)}`
      } finally {
        await setField(fields.source, sourceUrl)
      }
    },
  )

  await runTest("handler", "Output can replace the source field", async () => {
    await setField(fields.replaced, sourceUrl)
    const result = await runHandler(
      segmentStep({
        inputFieldId: fields.replaced,
        outputFieldId: fields.replaced,
      }),
    )
    assert(result.status === "success", `got ${result.status}`)
    assert(
      result.outputValues[0]?.customFieldId === fields.replaced,
      "output does not target the source field",
    )
    return result.outputValues[0]?.value ?? ""
  })

  await runTest(
    "handler",
    "Each run gets its own object; a retry reuses it",
    async () => {
      const step = segmentStep({ outputFormat: "mask" })
      const first = await runHandler(step, `${fixture.runId}-idem`)
      const retry = await runHandler(step, `${fixture.runId}-idem`)
      const next = await runHandler(step, `${fixture.runId}-idem-next`)
      assert(
        first.status === "success" &&
          retry.status === "success" &&
          next.status === "success",
        "a run did not succeed",
      )
      const [a, b, c] = [first, retry, next].map(
        (result) =>
          result.status === "success" && result.outputValues[0]?.value,
      )
      assert(a === b, `retry wrote ${b}, first ${a}`)
      assert(a !== c, "a later run overwrote the earlier object")
      assert(
        typeof a === "string" && a.includes("/segment-") && a.endsWith(".png"),
        `unexpected key ${a}`,
      )
      return `${a} / ${c}`
    },
  )

  // ── Errors ─────────────────────────────────────────────────────────────
  const expectStepError = async (
    sourceValue: string,
    expected: RegExp,
  ): Promise<string> => {
    await setField(fields.source, sourceValue)
    try {
      await runHandler(segmentStep())
    } catch (error) {
      assert(
        error instanceof ExpectedHeavyStepError,
        `not an expected step error: ${String(error)}`,
      )
      assert(expected.test(error.message), `message "${error.message}"`)
      return `"${preview(error.message)}"`
    } finally {
      await setField(fields.source, sourceUrl)
    }
    throw new Error("the step succeeded")
  }

  await runTest("errors", "Private-network URL is refused", () =>
    expectStepError("http://127.0.0.1:9/a.png", UNSAFE_URL_ERROR),
  )
  await runTest("errors", "Missing object fails cleanly", () =>
    expectStepError(
      `${storageUrl}/segment-qa/does-not-exist-${fixture.runId}.jpg`,
      MISSING_OBJECT_ERROR,
    ),
  )
  await runTest("errors", "Non-image body is rejected", async () => {
    const url = await uploadFixture(
      "not-an-image.png",
      Buffer.from("definitely not an image"),
      "image/png",
    )
    return await expectStepError(url, NOT_IMAGE_ERROR)
  })
  await runTest("errors", "Pixel ceiling is enforced before SAM", async () => {
    const width = Math.ceil(Math.sqrt(SEGMENT_MAX_INPUT_PIXELS)) + 1
    const huge = await sharp({
      create: { width, height: width, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer()
    const url = await uploadFixture("pixel-bomb.png", huge, "image/png")
    return await expectStepError(url, PIXEL_CEILING_ERROR)
  })
  await runTest("errors", "Empty source field is rejected", () =>
    expectStepError("", EMPTY_SOURCE_ERROR),
  )

  // ── Flow through the queues ────────────────────────────────────────────
  const buildFlowGraph = (step: SegmentStep) => {
    const routeNode = (value: string, y: number) => {
      const node = performActionNodeDefaultFn({
        nodeProps: { id: createId(), position: { x: 500, y } },
        dataProps: { name: `${prefix} | ${value}` },
      })
      node.data.details.steps = [
        {
          ...setCustomFieldStepDefaultFn(),
          inputFieldId: fields.route,
          operation: FieldOperationType.set,
          value,
        },
      ]
      return node
    }
    const start = performActionNodeDefaultFn({
      nodeProps: { id: createId(), position: { x: 100, y: 300 } },
      dataProps: { name: `${prefix} | segment`, isStartNode: true },
    })
    start.data.details.steps = [step]
    const routes = {
      success: routeNode("found", 100),
      skip: routeNode("not-found", 300),
      error: routeNode("failed", 500),
    }
    const edges = step.states.map((state) => {
      const targetNode = routes[state.stateType]
      return {
        id: createId(),
        source: start.id,
        sourceHandle: state.id,
        target: targetNode.id,
        targetHandle: targetNode.id,
      }
    })
    return {
      nodes: [start, routes.success, routes.skip, routes.error],
      edges,
      startNodeId: start.id,
    }
  }

  const runFlow = async (name: string, step: SegmentStep, source: string) => {
    if (!withWorkers) {
      throw new SkipTest("pass --with-workers with the worker running")
    }
    const { id: flowId } = await audit(() =>
      flowService.createPublished({
        workspaceId,
        data: { name: `${prefix} | ${name} | ${fixture.runId}` },
        graph: buildFlowGraph(step),
      }),
    )
    createdFlowIds.push(flowId)
    await setField(fields.source, source)
    await setField(fields.route, "")
    await integrationQueue.add(
      IntegrationJobAction.sendFlow,
      {
        type: IntegrationJobAction.sendFlow,
        data: {
          conversationId: conversation.id,
          contactInboxId: contactInbox.id,
          flowId,
        },
      },
      { jobId: `segment-qa-${fixture.runId}-${flowId}` },
    )
    const deadline = Date.now() + FLOW_TIMEOUT_MS - 10_000
    while (Date.now() < deadline) {
      const route = await readField(fields.route)
      if (route) {
        return { flowId, route }
      }
      await sleep(POLL_MS)
    }
    throw new Error(
      `flow ${flowId} did not route in time — are the integration and heavy workers running?`,
    )
  }

  await runTest(
    "flow",
    "Found routes success and writes the image",
    async () => {
      await setField(fields.output, "")
      const { flowId, route } = await runFlow(
        "found",
        segmentStep({ detailsOutputFieldId: fields.details }),
        sourceUrl,
      )
      assert(route === "found", `routed "${route}"`)
      const url = await readField(fields.output)
      assert(
        typeof url === "string" && url.endsWith(".png"),
        `output field "${preview(url)}"`,
      )
      const stats = await inspectResult(url, "cutout")
      const details = JSON.parse((await readField(fields.details)) ?? "{}")
      assert(details.count >= 1, `details ${preview(JSON.stringify(details))}`)
      return `flow ${flowId}: ${share(stats)} selected`
    },
    FLOW_TIMEOUT_MS,
  )

  await runTest(
    "flow",
    "Not found routes skip",
    async () => {
      const { flowId, route } = await runFlow(
        "not-found",
        segmentStep({ target: NO_MATCH_TARGET }),
        sourceUrl,
      )
      assert(route === "not-found", `routed "${route}"`)
      return `flow ${flowId}`
    },
    FLOW_TIMEOUT_MS,
  )

  await runTest(
    "flow",
    "Broken source routes error",
    async () => {
      const { flowId, route } = await runFlow(
        "failed",
        segmentStep(),
        `${storageUrl}/segment-qa/does-not-exist-${fixture.runId}.jpg`,
      )
      assert(route === "failed", `routed "${route}"`)
      return `flow ${flowId}`
    },
    FLOW_TIMEOUT_MS,
  )

  // ── Public Flow API ────────────────────────────────────────────────────
  const api = async (method: string, apiPath: string, body?: unknown) => {
    if (!(apiUrl && apiToken)) {
      throw new SkipTest("pass --api-url and --api-token")
    }
    const response = await fetch(`${apiUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, text }
  }

  const apiGraph = (step: SegmentStep) => {
    const { nodes, edges } = buildFlowGraph(step)
    return { nodes, edges }
  }

  await runTest("api", "Public spec exposes the step", async () => {
    const { status, text } = await api("GET", "/public-spec.json")
    assert(status === 200, `status ${status}`)
    assert(text.includes('"aiSegmentImage"'), "aiSegmentImage not in spec")
    return "aiSegmentImage present"
  })

  await runTest("api", "A flow with the step can be published", async () => {
    const { status, text } = await api("POST", "/v1/flows", {
      name: `${prefix} | api | ${fixture.runId}`,
      folderId: null,
      ...apiGraph(segmentStep({ detailsOutputFieldId: fields.details })),
      publish: true,
    })
    assert(
      status === 200 || status === 201,
      `status ${status}: ${preview(text)}`,
    )
    const { id } = JSON.parse(text) as { id: string }
    createdFlowIds.push(id)
    return `flow ${id}`
  })

  await runTest(
    "api",
    "An invalid step is rejected with field errors",
    async () => {
      const { status, text } = await api("POST", "/v1/flows", {
        name: `${prefix} | api invalid | ${fixture.runId}`,
        folderId: null,
        ...apiGraph(segmentStep({ detailsOutputFieldId: fields.output })),
        publish: true,
      })
      assert(status >= 400 && status < 500, `status ${status}`)
      assert(text.includes("detailsOutputFieldId"), `body ${preview(text)}`)
      return `${status} ${preview(text, 80)}`
    },
  )

  // ── Report ─────────────────────────────────────────────────────────────
  const failed = results.filter((result) => result.status === "failed")
  const skipped = results.filter((result) => result.status === "skipped")
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "passed" : "failed",
        total: results.length,
        failed: failed.length,
        skipped: skipped.length,
        fixture: {
          webchatId: fixture.webchat.id,
          contactId: contact.id,
          conversationId: conversation.id,
          sourceUrl,
        },
        failures: failed,
      },
      null,
      2,
    ),
  )
  if (failed.length > 0) {
    process.exitCode = 1
  }
} catch (error) {
  console.error(
    JSON.stringify(
      { status: "failed", results, error: String(error) },
      null,
      2,
    ),
  )
  process.exitCode = 1
} finally {
  if (createdFlowIds.length > 0 && !keepFlows) {
    await audit(() =>
      flowService.deleteMany({ workspaceId, ids: createdFlowIds }),
    ).catch((error: unknown) =>
      console.warn(`Could not delete QA flows: ${String(error)}`),
    )
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}
