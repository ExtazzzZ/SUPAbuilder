/**
 * End-to-end check of every Muse (Meta Model API) capability and model against
 * a real workspace. It calls the worker handlers directly with the workspace's
 * own Muse integration, on an isolated Webchat/contact fixture, so no real
 * customer is messaged and no queue worker has to be running.
 *
 * Matrix: every text model (Spark 1.3, Spark 1.2, Wonder 1.0) through generate
 * text, extract data (text/image/PDF), the AI agent step, auto-reply text and
 * tool calling; both analyze-image models; image generate/edit at each size;
 * call summary. Edge cases: the step's minimum token budget, very small agent
 * budgets, temperature limits, missing fields, unknown model, invalid key,
 * broken image URL and non-image edit input.
 *
 * Not covered: delivery through the chat worker (`replyByAI` waits on a chat
 * job) and system tools, which only that path wires.
 *
 * Usage:
 *   pnpm exec tsx scripts/test-muse-e2e.mts \
 *     --workspace-id 91652163796992 --apply [--env .env] [--quick] \
 *     [--only key,text,extract,analyze,image,agent,summary,errors]
 *
 * --quick runs only the default model and the base image sizes.
 *
 * The workspace must already have Muse connected (Settings → Integrations)
 * with Auto reply on. Fixtures are named "Muse QA …" and reused across runs;
 * each run creates a new contact. Generated images and the PDF fixture are
 * uploaded to the workspace storage like a real flow run.
 */

import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const getOption = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const workspaceId = getOption("--workspace-id")
const envFile = getOption("--env") ?? ".env"
const apply = args.includes("--apply")
const quick = args.includes("--quick")
const only = getOption("--only")?.split(",")
const prefix = "Muse QA"
const webchatName = `${prefix} | runtime Webchat`
const agentName = `${prefix} | agent`
const DEFAULT_MODEL = "muse-spark-1.3"
const TEXT_MODELS = quick
  ? [DEFAULT_MODEL]
  : ["muse-spark-1.3", "muse-spark-1.2", "muse-wonder-1.0"]
const ANALYZE_MODELS = quick
  ? [DEFAULT_MODEL]
  : ["muse-spark-1.3", "muse-spark-1.2"]
const IMAGE_MODEL = "muse-image-1.0"
const UNKNOWN_MODEL = "muse-qa-not-a-model"
// The flow steps' schema minimum, and the default for a new generate-text step.
const STEP_MIN_TOKENS = 250
const SIZE_S_PATTERN = /\bs\b|size s/
const TEST_TIMEOUT_MS = 180_000

if (!workspaceId) {
  throw new Error("Missing --workspace-id <workspaceId>.")
}
if (!apply) {
  console.log("Dry run: pass --apply to run against the workspace.")
  process.exit(0)
}

process.loadEnvFile(envFile)
process.env.SKIP_ENV_CHECK = "true"

// `sharp`, `ai` and `zod` are worker dependencies, not root ones.
const workerRequire = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
)
const sharp = workerRequire("sharp") as typeof import("sharp")
const { APICallError, generateText, isStepCount, tool } = (await import(
  pathToFileURL(workerRequire.resolve("ai")).href
)) as typeof import("ai")
const { z } = (await import(
  pathToFileURL(workerRequire.resolve("zod")).href
)) as typeof import("zod")

await import("../packages/business/src/audit/index.ts")
const { withAuditContext } = await import(
  "../packages/business/src/audit/context.ts"
)
const [
  { aiAgentService },
  { contactCustomFieldService },
  { contactService },
  { conversationService },
  { customFieldService },
  { integrationWebchatService },
  { workspaceMemberService },
  { verifyAiProviderApiKey },
  { resolveTenantSettings },
  { getPublicFileUrl },
  { aiIntegrationService, createAIModelInstance, generateCallSummary },
  { secretTextAuthSchema },
  { handleAIGenerateText },
  { handleAIAnalyzeImage },
  { handleAIExtractData },
  { handleAIGenerateTextAgent },
  { handleAIDeleteMessageHistory },
  { runAIAgentRunner },
  { resolveFlowAIModel },
  { generateAIReplyText },
  { getIntegrationContext },
  { generateImageOutput },
  { editImageOutput },
  { ExpectedHeavyStepError },
] = await Promise.all([
  import("../packages/business/src/ai-agent/service.ts"),
  import("../packages/business/src/contact-custom-field/service.ts"),
  import("../packages/business/src/contact/service.ts"),
  import("../packages/business/src/conversation/service.ts"),
  import("../packages/business/src/custom-field/service.ts"),
  import("../packages/business/src/integration-webchat/service.ts"),
  import("../packages/business/src/workspace-member/service.ts"),
  import("../packages/business/src/integration-ai-provider/verify.ts"),
  import("../packages/business/src/platform/settings.ts"),
  import("../packages/business/src/utils.ts"),
  import("../packages/ai/src/server/index.ts"),
  import("../packages/sdk/src/index.ts"),
  import("../apps/worker/src/integration/handlers/generate-text/index.ts"),
  import("../apps/worker/src/integration/handlers/analyze-image/index.ts"),
  import("../apps/worker/src/integration/handlers/extract-data/index.ts"),
  import(
    "../apps/worker/src/integration/handlers/generate-text-agent/index.ts"
  ),
  import(
    "../apps/worker/src/integration/handlers/delete-message-history/index.ts"
  ),
  import("../apps/worker/src/integration/handlers/shared/ai-agent-runner.ts"),
  import(
    "../apps/worker/src/integration/handlers/shared/flow-ai-model-resolver.ts"
  ),
  import(
    "../apps/worker/src/integration/handlers/automated-response/replies.ts"
  ),
  import("../apps/worker/src/integration/utils/contact.ts"),
  import("../apps/worker/src/heavy/handlers/generate-image.ts"),
  import("../apps/worker/src/heavy/handlers/edit-image.ts"),
  import("../apps/worker/src/heavy/handlers/errors.ts"),
])

const ownerId = await workspaceMemberService.findOwnerUserIdByWorkspaceId({
  workspaceId,
})
if (!ownerId) {
  throw new Error(`Workspace ${workspaceId} has no owner.`)
}

type Result = {
  group: string
  test: string
  model: string
  status: "passed" | "failed" | "skipped"
  ms: number
  note: string
}
const results: Result[] = []

const withTimeout = <T,>(promise: Promise<T>, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`${label} timed out after ${TEST_TIMEOUT_MS}ms`)),
        TEST_TIMEOUT_MS,
      ),
    ),
  ])

/** Runs one test; a failure is recorded and the run continues. */
const runTest = async (
  group: string,
  test: string,
  model: string,
  fn: () => Promise<string>,
) => {
  if (only && !only.includes(group)) {
    return
  }
  const startedAt = performance.now()
  let result: Result
  try {
    const note = await withTimeout(fn(), test)
    result = { group, test, model, status: "passed", ms: 0, note }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    result = { group, test, model, status: "failed", ms: 0, note }
  }
  result.ms = Math.round(performance.now() - startedAt)
  results.push(result)
  console.log(
    `[${result.status}] ${group} | ${test} | ${model} (${result.ms}ms) — ${result.note}`,
  )
}

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const preview = (text: string | null | undefined, max = 120) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Lowercase without diacritics, so "Hà Nội" matches "ha noi". */
const fold = (text: string | null | undefined) =>
  (text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()

const digits = (text: string | null | undefined) =>
  (text ?? "").replace(/\D/g, "")

const inspectImage = async (url: string) => {
  const response = await fetch(url)
  assert(response.ok, `GET ${url} returned ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(buffer).metadata()
  // WhatsApp treats WebP as a sticker, so Muse output must be converted.
  assert(meta.format !== "webp", `${url} is still WebP`)
  assert(meta.width && meta.height, `${url} has no dimensions`)
  return {
    width: meta.width,
    height: meta.height,
    label: `${meta.format} ${meta.width}x${meta.height} ${Math.round(buffer.length / 1024)}KB`,
  }
}

/** A one-page invoice PDF, written by hand so the script needs no PDF library. */
const buildInvoicePdf = () => {
  const lines = [
    "INVOICE INV-5531",
    "Customer: Tran Thi Mai",
    "Phone: 0912 345 678",
    "Item: Linen shirt x2",
    "Total: 1,250,000 VND",
    "Due date: 2026-11-15",
  ]
  const text = lines
    .map((line, index) => `${index === 0 ? "" : "0 -28 Td "}(${line}) Tj`)
    .join("\n")
  const content = `BT /F1 18 Tf 72 760 Td\n${text}\nET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

const audit = <T,>(fn: () => Promise<T>) =>
  withAuditContext({ userId: ownerId, workspaceId, source: "muse-qa" }, fn)

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
      type: "shortText" | "longText" = "longText",
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
            description: "Fixture for the Muse e2e script; safe to delete.",
          },
        }))
      ).id
    }
    const fields = {
      generatedText: await field("generated text"),
      generatedImage: await field("generated image", "shortText"),
      editedImage: await field("edited image", "shortText"),
      brokenImage: await field("broken image", "shortText"),
      invoicePdf: await field("invoice pdf", "shortText"),
      analysis: await field("image analysis"),
      extract: await field("extract value", "shortText"),
      agentOutput: await field("agent output"),
      badModel: await field("bad model output"),
    }

    const existingAgent = await aiAgentService.findBy({
      where: { workspaceId, name: agentName },
    })
    const agent =
      existingAgent ??
      (await aiAgentService.createAndReturn(workspaceId, {
        name: agentName,
        prompt:
          "You are a QA-only shop assistant. Answer in one or two short sentences.",
        messages: [],
        models: [{ provider: "muse", model: DEFAULT_MODEL }],
        temperature: 0.4,
        maxOutputTokens: 2048,
        tools: [],
        webSearchAuthorizedDomains: [],
        isDefault: false,
        isRichResponse: false,
        actionPrompt: "",
        actionRules: [],
      }))

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { contact, contactInbox } = await contactService.createWithInbox({
      workspaceId,
      input: {
        email: `muse-qa+${runId}@invalid.test`,
        firstName: "Muse QA",
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
    return {
      webchat,
      fields,
      agent,
      contact,
      contactInbox,
      conversation,
      runId,
    }
  })

  const { fields, contact, contactInbox, conversation } = fixture
  // Flow steps run outside a flow here; handlers never read the version.
  const stepProps = {
    conversation,
    contactInbox,
    flowVersion: {} as never,
  }
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
  let stepSeq = 0
  const stepId = () =>
    `${Date.now()}${(stepSeq++ % 1000).toString().padStart(3, "0")}`
  /** An in-memory copy of the QA agent; the runners take the agent as data. */
  const agentWith = (overrides: Partial<typeof fixture.agent>) =>
    ({ ...fixture.agent, ...overrides }) as typeof fixture.agent

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
    const path = `${ctx.storagePrefix}/muse-qa/${fixture.runId}/${fileName}`
    await ctx.uploader.putObject(path, body, { ContentType: contentType })
    return getPublicFileUrl(path, storageUrl)
  }

  const generateText_ = (
    model: string,
    text: string,
    options: {
      maxOutputTokens?: number
      temperature?: number
      system?: string
    } = {},
  ) =>
    audit(() =>
      handleAIGenerateText({
        ...stepProps,
        step: {
          id: stepId(),
          stepType: "aiGenerateText",
          provider: "muse",
          model,
          system: options.system ?? "",
          text,
          outputFieldId: fields.generatedText,
          tools: [],
          remember: false,
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxOutputTokens ?? 1024,
          states: [] as never,
        },
      }),
    )

  const analyze = (
    model: string,
    inputFieldId: string,
    prompt: string,
    maxOutputTokens = 1024,
  ) =>
    audit(() =>
      handleAIAnalyzeImage({
        ...stepProps,
        step: {
          id: stepId(),
          stepType: "aiAnalyzeImage",
          provider: "muse",
          model,
          prompt,
          inputFieldId,
          outputFieldId: fields.analysis,
          temperature: 0.2,
          maxOutputTokens,
        },
      }),
    )

  const extract = (
    model: string,
    input:
      | { inputType: "text"; text: string }
      | { inputType: "image" | "file"; fieldId: string },
    keys: Array<{ key: string; description: string }>,
  ) =>
    audit(() =>
      handleAIExtractData({
        ...stepProps,
        step: {
          id: stepId(),
          stepType: "aiExtractData",
          provider: "muse",
          model,
          ...(input.inputType === "text"
            ? // For text input this is the text itself (variables allowed),
              // not a custom field id.
              { inputType: "text", inputFieldId: input.text }
            : { inputType: input.inputType, inputFieldId: input.fieldId }),
          extractFields: keys.map(({ key, description }) => ({
            key,
            description,
            customFieldId: fields.extract,
          })),
        } as never,
      }),
    )
  const extracted = (result: { result: unknown }) =>
    (result.result ?? {}) as Record<string, string | null>

  // ── API key ────────────────────────────────────────────────────────────
  const { secretText } = secretTextAuthSchema.parse(integration.auth)

  await runTest("key", "API key is valid", "-", async () => {
    const validation = await verifyAiProviderApiKey("muse", secretText)
    assert(validation === "valid", `verify returned ${validation}`)
    return `integration ${integration.id}, default model ${integration.model}, autoReply ${integration.autoReply}`
  })

  await runTest("key", "Invalid key is rejected on connect", "-", async () => {
    const validation = await verifyAiProviderApiKey(
      "muse",
      "muse-qa-invalid-key",
    )
    assert(validation === "invalid", `verify returned ${validation}`)
    return "verify returned invalid"
  })

  await runTest(
    "key",
    "Invalid key fails a call with 401",
    DEFAULT_MODEL,
    async () => {
      const model = createAIModelInstance({
        model: {
          ...integration,
          auth: { ...integration.auth, secretText: "muse-qa-invalid-key" },
        } as typeof integration,
        provider: "muse",
        modelId: DEFAULT_MODEL,
      })
      try {
        await generateText({ model, prompt: "Hello" })
      } catch (error) {
        assert(APICallError.isInstance(error), `unexpected error: ${error}`)
        assert(error.statusCode === 401, `status ${error.statusCode}`)
        return `${error.statusCode} "${preview(error.message)}"`
      }
      throw new Error("call with an invalid key succeeded")
    },
  )

  // ── Generate text ──────────────────────────────────────────────────────
  for (const model of TEXT_MODELS) {
    await runTest("text", "Exact instruction", model, async () => {
      const result = await generateText_(
        model,
        "Reply with exactly this token and nothing else: MUSE_QA_OK",
        { system: "You are a terse assistant." },
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.generatedText)
      assert(value?.includes("MUSE_QA_OK"), `output: "${preview(value)}"`)
      return `"${preview(value)}"`
    })

    await runTest("text", "Vietnamese answer", model, async () => {
      const result = await generateText_(
        model,
        "Thủ đô của Việt Nam là thành phố nào? Chỉ trả lời tên thành phố.",
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.generatedText)
      assert(fold(value).includes("ha noi"), `output: "${preview(value)}"`)
      return `"${preview(value)}"`
    })

    await runTest(
      "text",
      `Step default budget (${STEP_MIN_TOKENS} tokens)`,
      model,
      async () => {
        const result = await generateText_(
          model,
          "Viết một câu chào khách hàng cho shop thời trang.",
          { maxOutputTokens: STEP_MIN_TOKENS },
        )
        assert(
          result.status === "success",
          `step error: ${result.errorMessage}`,
        )
        const value = await readField(fields.generatedText)
        // Reasoning counts toward max_tokens; a small budget used to come back
        // empty before the factory lowered the reasoning effort.
        assert(value?.trim(), "empty output at the step's default budget")
        return `"${preview(value)}"`
      },
    )

    await runTest(
      "text",
      `Long request at ${STEP_MIN_TOKENS} tokens`,
      model,
      async () => {
        const result = await generateText_(
          model,
          "Write a detailed 1500-word essay about the history of the silk road.",
          { maxOutputTokens: STEP_MIN_TOKENS },
        )
        assert(
          result.status === "success",
          `step error: ${result.errorMessage}`,
        )
        const value = await readField(fields.generatedText)
        assert(value?.trim(), "empty output when the answer is cut off")
        return `${value?.length ?? 0} chars, truncated as expected`
      },
    )

    // Muse breaks above 1 (empty reply or 500), so the provider caps it: the
    // 2 case checks that a step saved at the UI maximum still answers.
    for (const temperature of [0, 0.5, 1, 2]) {
      const label =
        temperature > 1
          ? `Temperature ${temperature} (capped to 1)`
          : `Temperature ${temperature}`
      await runTest("text", label, model, async () => {
        const result = await generateText_(model, "Say OK.", { temperature })
        assert(
          result.status === "success",
          `step error: ${result.errorMessage}`,
        )
        const value = await readField(fields.generatedText)
        assert(value?.trim(), "empty output")
        return `"${preview(value, 60)}"`
      })
    }

    await runTest("text", "Maximum budget (4096 tokens)", model, async () => {
      const result = await generateText_(
        model,
        "List five colors, comma separated.",
        { maxOutputTokens: 4096 },
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.generatedText)
      assert(value?.split(",").length >= 5, `output: "${preview(value)}"`)
      return `"${preview(value)}"`
    })
  }

  // ── Images (one model) ─────────────────────────────────────────────────
  const generateImage_ = (size: string) =>
    generateImageOutput({
      conversation,
      contactInbox,
      step: {
        id: stepId(),
        stepType: "aiGenerateImage",
        provider: "muse",
        model: IMAGE_MODEL,
        prompt:
          "A single red apple on a plain white table, studio product photo",
        size,
        quality: "auto",
        outputFieldId: fields.generatedImage,
      } as never,
    })
  const editImage_ = (inputFieldId: string, size: string, prompt: string) =>
    editImageOutput({
      conversation,
      contactInbox,
      step: {
        id: stepId(),
        stepType: "aiEditImage",
        provider: "muse",
        model: IMAGE_MODEL,
        inputFieldId,
        prompt,
        size,
        quality: "auto",
        outputFieldId: fields.editedImage,
      } as never,
    })
  const imageSizes = [
    { size: "1024x1024", shape: "square" },
    ...(quick
      ? []
      : [
          { size: "1536x1024", shape: "landscape" },
          { size: "1024x1536", shape: "portrait" },
          { size: "auto", shape: "any" },
        ]),
  ] as const
  const shapeOf = (width: number, height: number) => {
    if (width === height) {
      return "square"
    }
    return width > height ? "landscape" : "portrait"
  }

  let squareImageUrl: string | undefined
  for (const { size, shape } of imageSizes) {
    await runTest("image", `Generate image ${size}`, IMAGE_MODEL, async () => {
      const url = await generateImage_(size)
      const image = await inspectImage(url)
      if (shape !== "any") {
        const actual = shapeOf(image.width, image.height)
        assert(actual === shape, `expected ${shape}, got ${image.label}`)
      }
      if (size === "1024x1024") {
        squareImageUrl = url
        await setField(fields.generatedImage, url)
      }
      return `${image.label} ${url}`
    })
  }

  let editedImageUrl: string | undefined
  await runTest(
    "image",
    "Edit image auto keeps the shape",
    IMAGE_MODEL,
    async () => {
      assert(squareImageUrl, "no square image to edit")
      editedImageUrl = await editImage_(
        fields.generatedImage,
        "auto",
        "Make the apple bright green, keep everything else the same",
      )
      await setField(fields.editedImage, editedImageUrl)
      const image = await inspectImage(editedImageUrl)
      assert(
        shapeOf(image.width, image.height) === "square",
        `square input came back ${image.label}`,
      )
      return `${image.label} ${editedImageUrl}`
    },
  )

  if (!quick) {
    await runTest("image", "Edit image to portrait", IMAGE_MODEL, async () => {
      assert(squareImageUrl, "no square image to edit")
      const url = await editImage_(
        fields.generatedImage,
        "1024x1536",
        "Extend the scene into a tall portrait composition",
      )
      const image = await inspectImage(url)
      assert(
        shapeOf(image.width, image.height) === "portrait",
        `expected portrait, got ${image.label}`,
      )
      return `${image.label} ${url}`
    })
  }

  // ── Analyze image ──────────────────────────────────────────────────────
  for (const model of ANALYZE_MODELS) {
    await runTest("analyze", "Identify the object", model, async () => {
      assert(squareImageUrl, "no generated image")
      const result = await analyze(
        model,
        fields.generatedImage,
        "What fruit is in this image? Answer in one word.",
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.analysis)
      assert(fold(value).includes("apple"), `analysis: "${preview(value)}"`)
      return `"${preview(value)}"`
    })

    await runTest(
      "analyze",
      `Step minimum budget (${STEP_MIN_TOKENS} tokens)`,
      model,
      async () => {
        assert(squareImageUrl, "no generated image")
        const result = await analyze(
          model,
          fields.generatedImage,
          "Describe this image in one sentence.",
          STEP_MIN_TOKENS,
        )
        assert(
          result.status === "success",
          `step error: ${result.errorMessage}`,
        )
        const value = await readField(fields.analysis)
        assert(value?.trim(), "empty analysis at the step's minimum budget")
        return `"${preview(value)}"`
      },
    )

    await runTest("analyze", "Edited image is green", model, async () => {
      assert(editedImageUrl, "no edited image")
      const result = await analyze(
        model,
        fields.editedImage,
        "What color is the fruit in this image? Answer in one word.",
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.analysis)
      assert(fold(value).includes("green"), `analysis: "${preview(value)}"`)
      return `"${preview(value)}"`
    })
  }

  // ── Extract data ───────────────────────────────────────────────────────
  let invoiceUrl: string | undefined
  if (!only || only.includes("extract") || only.includes("errors")) {
    invoiceUrl = await uploadFixture(
      "invoice.pdf",
      buildInvoicePdf(),
      "application/pdf",
    )
    await setField(fields.invoicePdf, invoiceUrl)
  }

  for (const model of TEXT_MODELS) {
    await runTest("extract", "Vietnamese text", model, async () => {
      const result = await extract(
        model,
        {
          inputType: "text",
          text: "Chào shop, mình là Nguyễn Văn An, số điện thoại 0901234567. Mình muốn hỏi đơn hàng số 4217, áo khoác màu xanh size L.",
        },
        [
          { key: "name", description: "Customer full name" },
          { key: "phone", description: "Customer phone number" },
          { key: "orderNumber", description: "Order number" },
          { key: "product", description: "Product the customer asks about" },
          {
            key: "email",
            description: "Customer email address, null if not given",
          },
        ],
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const data = extracted(result)
      const json = JSON.stringify(data)
      assert(fold(data.name).includes("an"), `name: ${json}`)
      assert(digits(data.phone).includes("901234567"), `phone: ${json}`)
      assert(digits(data.orderNumber).includes("4217"), `order: ${json}`)
      // The text has no email; a value here is a hallucination.
      assert(!data.email?.includes("@"), `invented an email: ${json}`)
      return json
    })

    await runTest("extract", "Many fields (strict schema)", model, async () => {
      const keys = [
        "name",
        "phone",
        "city",
        "district",
        "street",
        "orderNumber",
        "product",
        "size",
        "color",
        "quantity",
      ]
      const result = await extract(
        model,
        {
          inputType: "text",
          text: "Mình là Lê Minh, 0987654321, giao tới 12 Lê Lợi, Quận 1, TP.HCM. Đặt 2 áo thun trắng size M, đơn 9031.",
        },
        keys.map((key) => ({ key, description: `The ${key}` })),
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const data = extracted(result)
      const missing = keys.filter((key) => !(key in data))
      assert(missing.length === 0, `missing keys: ${missing.join(", ")}`)
      assert(digits(data.orderNumber).includes("9031"), JSON.stringify(data))
      return JSON.stringify(data)
    })

    await runTest("extract", "Image input", model, async () => {
      assert(squareImageUrl, "no generated image")
      const result = await extract(
        model,
        { inputType: "image", fieldId: fields.generatedImage },
        [
          { key: "fruit", description: "The fruit shown" },
          { key: "color", description: "The fruit's color" },
        ],
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const data = extracted(result)
      assert(fold(data.fruit).includes("apple"), JSON.stringify(data))
      return JSON.stringify(data)
    })

    await runTest("extract", "PDF input", model, async () => {
      assert(invoiceUrl, "no invoice PDF")
      const result = await extract(
        model,
        { inputType: "file", fieldId: fields.invoicePdf },
        [
          { key: "invoiceNumber", description: "Invoice number" },
          { key: "customer", description: "Customer name" },
          { key: "total", description: "Total amount" },
          { key: "dueDate", description: "Due date" },
        ],
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const data = extracted(result)
      const json = JSON.stringify(data)
      assert(data.invoiceNumber?.includes("5531"), `invoice: ${json}`)
      assert(fold(data.customer).includes("mai"), `customer: ${json}`)
      assert(digits(data.total).includes("1250000"), `total: ${json}`)
      return json
    })
  }

  // ── AI agent ───────────────────────────────────────────────────────────
  for (const model of TEXT_MODELS) {
    await runTest("agent", "Flow step: AI agent", model, async () => {
      const result = await audit(() =>
        handleAIGenerateTextAgent({
          ...stepProps,
          step: {
            id: stepId(),
            stepType: "aiGenerateTextAgent",
            provider: "muse",
            model,
            aiAgentId: fixture.agent.id,
            message:
              "Greet me in one short sentence and include the token MUSE_QA_AGENT.",
            outputFieldId: fields.agentOutput,
            rememberConversation: false,
          },
        }),
      )
      assert(result.status === "success", `step error: ${result.errorMessage}`)
      const value = await readField(fields.agentOutput)
      assert(value?.includes("MUSE_QA_AGENT"), `output: "${preview(value)}"`)
      return `"${preview(value)}"`
    })

    await runTest("agent", "Auto-reply text", model, async () => {
      // The auto-reply model picker only uses integrations with Auto reply on.
      const reply = await generateAIReplyText({
        conversation,
        contactInbox,
        aiAgent: agentWith({ models: [{ provider: "muse", model }] }),
        messages: [
          { role: "user", content: "Shop có giao hàng ra Hà Nội không?" },
        ],
      })
      assert(reply, "no auto-reply model answered (is Auto reply on?)")
      assert(reply.provider === "muse", `answered by ${reply.provider}`)
      assert(reply.modelId === model, `answered by ${reply.modelId}`)
      assert(reply.text.trim(), "empty reply")
      return `"${preview(reply.text)}"`
    })

    await runTest("agent", "Remembers earlier turns", model, async () => {
      const result = await runAIAgentRunner({
        conversation,
        contactInbox,
        aiAgent: agentWith({ models: [{ provider: "muse", model }] }),
        messages: [
          { role: "user", content: "Hi, my name is Linh and I wear size S." },
          { role: "assistant", content: "Nice to meet you, Linh!" },
          { role: "user", content: "What is my name and my size?" },
        ],
      })
      assert(result?.responded, "agent did not respond")
      const text = fold(result.fullText)
      assert(
        text.includes("linh") && SIZE_S_PATTERN.test(text),
        `reply: "${preview(result.fullText)}"`,
      )
      return `"${preview(result.fullText)}"`
    })

    // The agent form allows any budget from 1 token.
    for (const maxOutputTokens of [250, 100]) {
      await runTest(
        "agent",
        `Small agent budget (${maxOutputTokens} tokens)`,
        model,
        async () => {
          const result = await runAIAgentRunner({
            conversation,
            contactInbox,
            aiAgent: agentWith({
              models: [{ provider: "muse", model }],
              maxOutputTokens,
            }),
            messages: [{ role: "user", content: "Do you sell linen shirts?" }],
          })
          assert(
            result?.responded && result.fullText.trim(),
            `no reply at ${maxOutputTokens} tokens`,
          )
          return `"${preview(result.fullText)}"`
        },
      )
    }

    await runTest("agent", "Tool calling", model, async () => {
      const resolved = await resolveFlowAIModel({
        workspaceId,
        provider: "muse",
        modelId: model,
      })
      assert(resolved.ok, "model did not resolve")
      const calls: string[] = []
      const result = await generateText({
        model: resolved.model,
        prompt: "What is the status of order 4217? Use the tool.",
        maxOutputTokens: 2048,
        stopWhen: isStepCount(3),
        tools: {
          getOrderStatus: tool({
            description: "Look up the shipping status of an order",
            inputSchema: z.object({ orderNumber: z.string() }),
            execute: ({ orderNumber }) => {
              calls.push(orderNumber)
              return { orderNumber, status: "shipped", eta: "2026-11-02" }
            },
          }),
        },
      })
      assert(
        calls.some((call) => call.includes("4217")),
        `tool calls: ${calls}`,
      )
      assert(
        fold(result.text).includes("ship"),
        `reply: "${preview(result.text)}"`,
      )
      return `called with ${calls.join(",")}; "${preview(result.text)}"`
    })
  }

  await runTest(
    "agent",
    "Falls back to the next model when one fails",
    `${UNKNOWN_MODEL} → ${DEFAULT_MODEL}`,
    async () => {
      const result = await runAIAgentRunner({
        conversation,
        contactInbox,
        aiAgent: agentWith({
          models: [
            { provider: "muse", model: UNKNOWN_MODEL },
            { provider: "muse", model: DEFAULT_MODEL },
          ],
        }),
        messages: [{ role: "user", content: "Hello" }],
      })
      assert(result?.responded, "no model responded")
      assert(result.modelId === DEFAULT_MODEL, `answered by ${result.modelId}`)
      return `answered by ${result.modelId}`
    },
  )

  await runTest("agent", "Flow step: Delete message history", "-", async () => {
    const result = await audit(() =>
      handleAIDeleteMessageHistory({
        ...stepProps,
        step: {
          id: stepId(),
          stepType: "aiDeleteMessageHistory",
          provider: "muse",
        },
      }),
    )
    assert(result.status === "success", `step error: ${result.errorMessage}`)
    return "AI history marker reset"
  })

  // ── Call summary (fixed model) ─────────────────────────────────────────
  const transcripts = {
    English: [
      "Agent: Hello, how can I help you?",
      "Customer: My order 4217 has not arrived yet, it was due Monday.",
      "Agent: Sorry about that. I will check with the courier and call you back by 5pm today.",
      "Customer: Thanks, please also update my address to 12 Le Loi, District 1.",
    ],
    Vietnamese: [
      "Nhân viên: Dạ em chào anh, em hỗ trợ gì được ạ?",
      "Khách: Đơn 5588 của anh giao sai màu, anh đặt đen mà nhận màu trắng.",
      "Nhân viên: Em xin lỗi anh, em sẽ tạo yêu cầu đổi hàng và gửi mã vận đơn mới trong hôm nay.",
      "Khách: Ok em, nhớ gọi trước khi giao nhé.",
    ],
  }
  for (const [language, lines] of Object.entries(transcripts)) {
    await runTest(
      "summary",
      `Call summary (${language})`,
      DEFAULT_MODEL,
      async () => {
        const summary = await generateCallSummary({
          workspaceId,
          provider: "muse",
          transcriptText: lines.join("\n"),
        })
        const order = language === "English" ? "4217" : "5588"
        const all = [
          summary.summary,
          ...(summary.keyPoints ?? []),
          ...(summary.actionItems ?? []),
        ].join(" ")
        assert(all.includes(order), `order ${order} missing: "${preview(all)}"`)
        assert(summary.actionItems?.length, "no action items")
        return `"${preview(summary.summary)}" keyPoints=${summary.keyPoints?.length ?? 0} actionItems=${summary.actionItems.length}`
      },
    )
  }

  // ── Failures surface as errors ─────────────────────────────────────────
  await runTest(
    "errors",
    "Unknown model returns 404",
    UNKNOWN_MODEL,
    async () => {
      const resolved = await resolveFlowAIModel({
        workspaceId,
        provider: "muse",
        modelId: UNKNOWN_MODEL,
      })
      assert(resolved.ok, "Muse model did not resolve")
      try {
        await generateText({ model: resolved.model, prompt: "Hello" })
      } catch (error) {
        assert(APICallError.isInstance(error), `unexpected error: ${error}`)
        assert(error.statusCode === 404, `status ${error.statusCode}`)
        return `${error.statusCode} "${preview(error.message)}"`
      }
      throw new Error("call with an unknown model succeeded")
    },
  )

  await runTest(
    "errors",
    "Unknown model fails the step",
    UNKNOWN_MODEL,
    async () => {
      const result = await audit(() =>
        handleAIGenerateText({
          ...stepProps,
          step: {
            id: stepId(),
            stepType: "aiGenerateText",
            provider: "muse",
            model: UNKNOWN_MODEL,
            text: "Hello",
            outputFieldId: fields.badModel,
            tools: [],
            remember: false,
            temperature: 0.2,
            maxOutputTokens: STEP_MIN_TOKENS,
            states: [] as never,
          },
        }),
      )
      assert(
        result.status === "error",
        `expected error, got ${result.status} with output "${preview(await readField(fields.badModel))}"`,
      )
      return `"${preview(result.errorMessage)}"`
    },
  )

  await runTest(
    "errors",
    "Broken image URL fails analyze",
    DEFAULT_MODEL,
    async () => {
      await setField(
        fields.brokenImage,
        `${storageUrl}/muse-qa/does-not-exist-${fixture.runId}.jpg`,
      )
      const result = await analyze(
        DEFAULT_MODEL,
        fields.brokenImage,
        "Describe this image.",
      )
      assert(result.status === "error", `expected error, got ${result.status}`)
      return `"${preview(result.errorMessage)}"`
    },
  )

  await runTest(
    "errors",
    "Non-image input fails edit",
    IMAGE_MODEL,
    async () => {
      assert(invoiceUrl, "no PDF to feed the edit step")
      try {
        await editImage_(fields.invoicePdf, "auto", "Make it blue")
      } catch (error) {
        assert(
          error instanceof ExpectedHeavyStepError,
          `unexpected error: ${error}`,
        )
        return `"${preview(error.message)}"`
      }
      throw new Error("editing a PDF succeeded")
    },
  )

  // ── Report ─────────────────────────────────────────────────────────────
  const failed = results.filter((result) => result.status === "failed")
  const byModel = new Map<string, { passed: number; failed: number }>()
  for (const result of results) {
    const entry = byModel.get(result.model) ?? { passed: 0, failed: 0 }
    entry[result.status === "failed" ? "failed" : "passed"]++
    byModel.set(result.model, entry)
  }
  console.log("\nBy model:")
  for (const [model, { passed, failed: failedCount }] of byModel) {
    console.log(`  ${model.padEnd(40)} ${passed} passed, ${failedCount} failed`)
  }
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "passed" : "failed",
        total: results.length,
        failed: failed.length,
        fixture: {
          webchatId: fixture.webchat.id,
          agentId: fixture.agent.id,
          contactId: contact.id,
          conversationId: conversation.id,
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
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}
