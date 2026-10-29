/**
 * End-to-end check of the AI Speech to Text step on Muse Voice Transcribe
 * (`muse-voice-transcribe-1.0`, Meta Model API) against a real workspace and
 * its own Muse integration, on an isolated Webchat/contact fixture, so no real
 * customer is messaged.
 *
 * Groups (all run by default unless noted):
 *   client   `transcribeWithMuse` against the live API: 16/24 kHz, LIST/JUNK
 *            chunks, languageBias + keywords, a reused sessionId (BullMQ
 *            retry), invalid key, timeout, oversized request.
 *   probe    what Meta itself does with audio the local WAV check rejects
 *            (stereo, 44.1/8 kHz, 8-bit, float, extensible, ogg) and with a
 *            streaming-size header it accepts. Fails only when the two
 *            disagree in the unsafe direction or Meta's rejection would retry.
 *   handler  the heavy handler with real storage: 16/24 kHz, octet-stream
 *            content type, LIST chunk, languageBias + keywords.
 *   errors   every format the step must route to the error state without
 *            calling Meta: ogg/mp3 voice notes, stereo, 44.1 kHz, 8-bit,
 *            float, extensible, empty, truncated, missing object, private
 *            URL, empty field.
 *   limits   (skipped by --quick) exactly 10 min of 24 kHz mono is
 *            transcribed; 10 min + 1 s and a body over
 *            MUSE_TRANSCRIBE_MAX_AUDIO_BYTES are refused before Meta.
 *   flow     (--with-workers) a real published flow run through the
 *            integration and heavy queues: Success / Error routing. Needs
 *            `pnpm --filter worker dev` (integration + heavy) running.
 *   api      (--api-url + --api-token) public Flow API: the Muse branch in
 *            the spec, publish a flow holding the step, reject invalid ones.
 *
 * Usage:
 *   pnpm exec tsx scripts/test-muse-speech-to-text-e2e.mts \
 *     --workspace-id 91652163796992 --apply [--env .env] [--quick] \
 *     [--only client,probe,handler,errors,limits,flow,api] \
 *     [--audio-file speech.wav --expect "xin chào,hà nội" --language Vietnamese] \
 *     [--speech auto|openai|flite] \
 *     [--with-workers] \
 *     [--api-url http://localhost:3123/api --api-token cbx_…] [--keep-flows]
 *
 * Speech source: --audio-file (any 16-bit PCM WAV; downmixed and resampled
 * here) wins. Otherwise `auto` uses the workspace's OpenAI integration for a
 * Vietnamese TTS sentence (raw PCM, cached under the OS temp dir so reruns are
 * free) and falls back to the local ffmpeg `flite` filter (English). This is
 * only how the test fixture is made — the step itself never converts audio.
 *
 * The workspace must already have Muse connected (Settings → Integrations).
 * Fixtures are named "STT QA …" and reused; each run creates a new contact
 * and uploads under `stt-qa/<run>/`. A full run makes about 20 paid Muse
 * calls on a few seconds of audio, plus one 10-minute transcription.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
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
const withWorkers = args.includes("--with-workers")
const keepFlows = args.includes("--keep-flows")
const only = getOption("--only")?.split(",")
const audioFile = getOption("--audio-file")
const expectOption = getOption("--expect")
const languageOption = getOption("--language")
const speechSource = getOption("--speech") ?? "auto"
const apiUrl = getOption("--api-url")?.replace(/\/$/, "")
const apiToken = getOption("--api-token")
const prefix = "STT QA"
const webchatName = `${prefix} | runtime Webchat`
const TTS_MODEL = "gpt-4o-mini-tts"
const TTS_VOICE = "alloy"
// OpenAI `pcm` output: raw signed 16-bit little-endian mono.
const OPENAI_PCM_RATE = 24_000
const VI_PHRASE =
  "Xin chào, tôi muốn đặt hai chiếc áo sơ mi linen, giao đến Hà Nội vào thứ Sáu. Mã đơn hàng của tôi là ChatbotX năm năm ba một."
const VI_EXPECTED = ["xin chào", "áo sơ mi", "hà nội", "đơn hàng"]
const EN_PHRASE =
  "Hello, I would like to order two linen shirts, delivered to Hanoi on Friday. My order code is ChatbotX five five three one."
const EN_EXPECTED = ["hello", "order", "shirts", "friday"]
const KEYWORDS = ["ChatbotX", "linen"]
const TEST_TIMEOUT_MS = 240_000
const LONG_TIMEOUT_MS = 11 * 60_000
const FLOW_TIMEOUT_MS = 420_000
const POLL_MS = 3000
// The handler's expected-error messages.
const FORMAT_HINT = /requires WAV PCM 16-bit mono 16\/24 kHz/
const UNSUPPORTED_FORMAT_ERROR = /unsupported audio format/i
const MISSING_OBJECT_ERROR = /audio download failed with status 4\d\d/i
const UNSAFE_URL_ERROR = /unsafe audio url/i
const EMPTY_FIELD_ERROR = /no audio url/i
const TOO_LONG_ERROR = /at most 600 s/
const TOO_LARGE_ERROR = /exceeds size limit/

if (!workspaceId) {
  throw new Error("Missing --workspace-id <workspaceId>.")
}
if (!["auto", "openai", "flite"].includes(speechSource)) {
  throw new Error("--speech must be auto, openai or flite.")
}
if (!apply) {
  console.log("Dry run: pass --apply to run against the workspace.")
  process.exit(0)
}

process.loadEnvFile(envFile)
// Under SKIP_ENV_CHECK the worker env is raw `process.env`, so its numeric
// limits (MUSE_TRANSCRIBE_TIMEOUT_MS, …) would be undefined and the handler
// would abort at once. Parse it first; every later import shares this module.
const { env: workerEnv } = await import("../apps/worker/src/env.ts").catch(
  (error: unknown) => {
    throw new Error(
      `The worker env does not validate with ${envFile}; fix it as for \`pnpm --filter worker dev\`. ${String(error)}`,
    )
  },
)
process.env.SKIP_ENV_CHECK = "true"

// `ai` is a worker dependency, not a root one.
const workerRequire = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
)
const { generateSpeech } = (await import(
  pathToFileURL(workerRequire.resolve("ai")).href
)) as typeof import("ai")

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
  {
    MUSE_TRANSCRIBE_MAX_REQUEST_BYTES,
    MUSE_TRANSCRIBE_MAX_SECONDS,
    MuseTranscribeError,
    MuseWavFormatError,
    aiIntegrationService,
    getAIModel,
    inspectMuseWav,
    transcribeWithMuse,
  },
  { createId },
  flowConfig,
  { IntegrationJobAction, integrationQueue },
  { getIntegrationContext },
  { speechToTextOutput },
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
  import("../packages/utils/src/id.ts"),
  import("../packages/flow-config/src/index.ts"),
  import("../packages/worker-config/src/queues/integration/index.ts"),
  import("../apps/worker/src/integration/utils/contact.ts"),
  import("../apps/worker/src/heavy/handlers/speech-to-text.ts"),
  import("../apps/worker/src/heavy/handlers/errors.ts"),
])
const {
  AISpeechToTextDefaultFn,
  FieldOperationType,
  MUSE_TRANSCRIPTION_MODEL,
  museVoiceLanguages,
  performActionNodeDefaultFn,
  setCustomFieldStepDefaultFn,
} = flowConfig
type SpeechStep = ReturnType<typeof AISpeechToTextDefaultFn>
type MuseVoiceLanguage = (typeof museVoiceLanguages)[number]

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

/** Lowercase, no diacritics or punctuation, so "Hà Nội," matches "ha noi". */
const fold = (text: string | null | undefined) =>
  (text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// ── WAV fixtures ───────────────────────────────────────────────────────────
// Built here so every byte of every case is known; the step never converts.

const WAV_UNKNOWN_SIZE = 0xff_ff_ff_ff
const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xff_fe
const KSDATAFORMAT_SUBTYPE_PCM = "0100000000001000800000aa00389b71"

const riffChunk = (id: string, body: Buffer, declaredSize = body.length) => {
  const header = Buffer.alloc(8)
  header.write(id, 0, "ascii")
  header.writeUInt32LE(declaredSize, 4)
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)])
}

type WavSpec = {
  /** Mono source samples; copied to every channel. */
  samples: Int16Array
  sampleRate: number
  channels?: number
  bitsPerSample?: 8 | 16 | 32
  formatTag?: number
  /** Chunks written between `fmt ` and `data`. */
  extraChunks?: { id: string; body: Buffer }[]
  /** RIFF and data sizes left as 0xFFFFFFFF, as streaming writers do. */
  streaming?: boolean
}

const encodeWav = ({
  samples,
  sampleRate,
  channels = 1,
  bitsPerSample = 16,
  formatTag = bitsPerSample === 32 ? WAVE_FORMAT_FLOAT : WAVE_FORMAT_PCM,
  extraChunks = [],
  streaming = false,
}: WavSpec) => {
  const bytesPerSample = bitsPerSample / 8
  let data: Buffer
  if (channels === 1 && bitsPerSample === 16) {
    data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  } else {
    data = Buffer.alloc(samples.length * channels * bytesPerSample)
    let offset = 0
    for (const sample of samples) {
      for (let channel = 0; channel < channels; channel += 1) {
        if (bitsPerSample === 8) {
          data.writeUInt8(Math.floor(sample / 256) + 128, offset)
        } else if (bitsPerSample === 32) {
          data.writeFloatLE(sample / 32_768, offset)
        } else {
          data.writeInt16LE(sample, offset)
        }
        offset += bytesPerSample
      }
    }
  }

  const extensible = formatTag === WAVE_FORMAT_EXTENSIBLE
  const fmt = Buffer.alloc(extensible ? 40 : 16)
  fmt.writeUInt16LE(formatTag, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 8)
  fmt.writeUInt16LE(channels * bytesPerSample, 12)
  fmt.writeUInt16LE(bitsPerSample, 14)
  if (extensible) {
    fmt.writeUInt16LE(22, 16)
    fmt.writeUInt16LE(bitsPerSample, 18)
    fmt.writeUInt32LE(channels === 1 ? 0x4 : 0x3, 20)
    Buffer.from(KSDATAFORMAT_SUBTYPE_PCM, "hex").copy(fmt, 24)
  }

  const body = Buffer.concat([
    riffChunk("fmt ", fmt),
    ...extraChunks.map((chunk) => riffChunk(chunk.id, chunk.body)),
    riffChunk("data", data, streaming ? WAV_UNKNOWN_SIZE : data.length),
  ])
  const riff = Buffer.alloc(12)
  riff.write("RIFF", 0, "ascii")
  riff.writeUInt32LE(streaming ? WAV_UNKNOWN_SIZE : body.length + 4, 4)
  riff.write("WAVE", 8, "ascii")
  return Buffer.concat([riff, body])
}

/** Reads any 16-bit PCM WAV (for --audio-file and TTS output). */
const decodePcm16Wav = (bytes: Buffer, label: string) => {
  assert(
    bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE",
    `${label} is not a WAV file`,
  )
  let fmt:
    | { formatTag: number; channels: number; sampleRate: number; bits: number }
    | undefined
  let data: Buffer | undefined
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4)
    const start = offset + 8
    let size = bytes.readUInt32LE(offset + 4)
    if (
      id === "data" &&
      (size === WAV_UNKNOWN_SIZE || size === 0 || start + size > bytes.length)
    ) {
      size = bytes.length - start
    }
    if (id === "fmt ") {
      fmt = {
        formatTag: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      }
    } else if (id === "data") {
      data = bytes.subarray(start, start + size)
      break
    }
    offset = start + size + (size % 2)
  }
  assert(fmt && data, `${label} has no fmt or data chunk`)
  assert(
    fmt.bits === 16 &&
      (fmt.formatTag === WAVE_FORMAT_PCM ||
        fmt.formatTag === WAVE_FORMAT_EXTENSIBLE),
    `${label} must be 16-bit PCM WAV (got format ${fmt.formatTag}, ${fmt.bits}-bit)`,
  )
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    samples: pcm16FromBytes(data),
  }
}

/** Copies little-endian PCM16 bytes into an aligned Int16Array. */
const pcm16FromBytes = (bytes: Uint8Array) => {
  const aligned = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2))
  aligned.set(bytes.subarray(0, aligned.byteLength))
  return new Int16Array(aligned.buffer)
}

const toMono = (samples: Int16Array, channels: number) => {
  if (channels === 1) {
    return samples
  }
  const mono = new Int16Array(Math.floor(samples.length / channels))
  for (let frame = 0; frame < mono.length; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] ?? 0
    }
    mono[frame] = Math.round(sum / channels)
  }
  return mono
}

/** Linear resampling; plenty for a speech fixture. */
const resample = (samples: Int16Array, from: number, to: number) => {
  if (from === to) {
    return samples
  }
  const out = new Int16Array(Math.round((samples.length * to) / from))
  for (let index = 0; index < out.length; index += 1) {
    const position = (index * from) / to
    const left = Math.floor(position)
    const fraction = position - left
    const a = samples[left] ?? 0
    const b = samples[left + 1] ?? a
    out[index] = Math.round(a + (b - a) * fraction)
  }
  return out
}

/** Repeats the speech with 1 s gaps until exactly `seconds` long. */
const fillTo = (speech: Int16Array, rate: number, seconds: number) => {
  const out = new Int16Array(Math.round(rate * seconds))
  let offset = 0
  let repeats = 0
  while (offset < out.length) {
    out.set(
      speech.subarray(0, Math.min(speech.length, out.length - offset)),
      offset,
    )
    offset += speech.length + rate
    repeats += 1
  }
  return { samples: out, repeats }
}

/** An exact, own-buffer copy, as the worker hands the client. */
const toUpload = (bytes: Buffer) => new Uint8Array(bytes)

const audit = <T,>(fn: () => Promise<T>) =>
  withAuditContext({ userId: ownerId, workspaceId, source: "stt-qa" }, fn)

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

  // ── Speech source ──────────────────────────────────────────────────────
  type Speech = {
    source: string
    sampleRate: number
    samples: Int16Array
    expected: string[]
    languageBias: MuseVoiceLanguage[]
  }

  const parseLanguages = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((language) => language.trim())
      .filter(Boolean)
      .map((language) => {
        assert(
          (museVoiceLanguages as readonly string[]).includes(language),
          `--language "${language}" is not one of: ${museVoiceLanguages.join(", ")}`,
        )
        return language as MuseVoiceLanguage
      })

  const cacheDir = path.join(os.tmpdir(), "chatbotx-muse-stt-qa")
  const cachePath = (key: string, extension: string) => {
    mkdirSync(cacheDir, { recursive: true })
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16)
    return path.join(cacheDir, `${hash}.${extension}`)
  }

  const fromOpenAI = async (): Promise<Speech | undefined> => {
    const file = cachePath(`${TTS_MODEL}|${TTS_VOICE}|${VI_PHRASE}`, "pcm")
    let pcm: Uint8Array
    if (existsSync(file)) {
      pcm = readFileSync(file)
    } else {
      const openai = await aiIntegrationService.findBy({
        workspaceId,
        provider: "openai",
      })
      if (!openai) {
        return
      }
      const provider = getAIModel(openai, "openai")
      assert("speech" in provider, "the OpenAI provider has no speech model")
      const { audio } = await generateSpeech({
        model: provider.speech(TTS_MODEL),
        text: VI_PHRASE,
        voice: TTS_VOICE,
        outputFormat: "pcm",
      })
      pcm = audio.uint8Array
      writeFileSync(file, pcm)
    }
    const bytes = Buffer.from(pcm)
    // Some SDK versions wrap the PCM in a WAV header.
    const decoded =
      bytes.toString("ascii", 0, 4) === "RIFF"
        ? decodePcm16Wav(bytes, "OpenAI TTS output")
        : {
            sampleRate: OPENAI_PCM_RATE,
            channels: 1,
            samples: pcm16FromBytes(bytes),
          }
    return {
      source: `OpenAI ${TTS_MODEL} (vi)`,
      sampleRate: decoded.sampleRate,
      samples: toMono(decoded.samples, decoded.channels),
      expected: VI_EXPECTED,
      languageBias: ["Vietnamese"],
    }
  }

  const fromFlite = (): Speech => {
    const textFile = cachePath(EN_PHRASE, "txt")
    const wavFile = cachePath(`flite|${EN_PHRASE}`, "wav")
    if (!existsSync(wavFile)) {
      writeFileSync(textFile, EN_PHRASE)
      const ffmpeg = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `flite=textfile=${textFile}:voice=slt`,
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          wavFile,
        ],
        { encoding: "utf8" },
      )
      assert(
        ffmpeg.status === 0,
        `ffmpeg flite failed (${ffmpeg.error?.message ?? ffmpeg.stderr}); pass --audio-file instead`,
      )
    }
    const decoded = decodePcm16Wav(readFileSync(wavFile), "flite output")
    return {
      source: "ffmpeg flite (en)",
      sampleRate: decoded.sampleRate,
      samples: toMono(decoded.samples, decoded.channels),
      expected: EN_EXPECTED,
      languageBias: ["English"],
    }
  }

  const loadSpeech = async (): Promise<Speech> => {
    if (audioFile) {
      const decoded = decodePcm16Wav(readFileSync(audioFile), audioFile)
      return {
        source: audioFile,
        sampleRate: decoded.sampleRate,
        samples: toMono(decoded.samples, decoded.channels),
        expected: (expectOption ?? "")
          .split(",")
          .map((phrase) => phrase.trim())
          .filter(Boolean),
        languageBias: parseLanguages(languageOption),
      }
    }
    if (speechSource !== "flite") {
      const speech = await fromOpenAI().catch((error: unknown) => {
        if (speechSource === "openai") {
          throw error
        }
        console.warn(`OpenAI TTS unavailable, using flite: ${String(error)}`)
        return
      })
      if (speech) {
        return speech
      }
      assert(
        speechSource === "auto",
        "--speech openai needs an OpenAI integration",
      )
    }
    return fromFlite()
  }

  const speech = await loadSpeech()
  const pcm16k = resample(speech.samples, speech.sampleRate, 16_000)
  const pcm24k = resample(speech.samples, speech.sampleRate, 24_000)
  const speechSeconds = pcm16k.length / 16_000
  assert(
    speechSeconds >= 1 && speechSeconds <= 120,
    `speech fixture is ${speechSeconds.toFixed(1)} s; use 1–120 s`,
  )
  console.log(
    `Speech: ${speech.source}, ${speechSeconds.toFixed(1)} s, expect [${speech.expected.join(", ")}], languageBias [${speech.languageBias.join(", ")}]`,
  )
  console.log(
    `Limits: timeout ${workerEnv.MUSE_TRANSCRIBE_TIMEOUT_MS} ms, download ${workerEnv.MUSE_TRANSCRIBE_MAX_AUDIO_BYTES} bytes`,
  )

  const listChunk = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    riffChunk("ISFT", Buffer.from("ChatbotX STT QA\0", "ascii")),
  ])
  const wavs = {
    mono16k: encodeWav({ samples: pcm16k, sampleRate: 16_000 }),
    mono24k: encodeWav({ samples: pcm24k, sampleRate: 24_000 }),
    // A LIST chunk before data, and an odd-sized JUNK chunk with its pad byte.
    withList: encodeWav({
      samples: pcm16k,
      sampleRate: 16_000,
      extraChunks: [
        { id: "LIST", body: listChunk },
        { id: "JUNK", body: Buffer.alloc(3) },
      ],
    }),
    streaming: encodeWav({
      samples: pcm16k,
      sampleRate: 16_000,
      streaming: true,
    }),
    stereo: encodeWav({ samples: pcm16k, sampleRate: 16_000, channels: 2 }),
    mono44k: encodeWav({
      samples: resample(speech.samples, speech.sampleRate, 44_100),
      sampleRate: 44_100,
    }),
    mono8k: encodeWav({
      samples: resample(speech.samples, speech.sampleRate, 8000),
      sampleRate: 8000,
    }),
    eightBit: encodeWav({
      samples: pcm16k,
      sampleRate: 16_000,
      bitsPerSample: 8,
    }),
    float32: encodeWav({
      samples: pcm16k,
      sampleRate: 16_000,
      bitsPerSample: 32,
    }),
    extensible: encodeWav({
      samples: pcm16k,
      sampleRate: 16_000,
      formatTag: WAVE_FORMAT_EXTENSIBLE,
    }),
    empty: encodeWav({ samples: new Int16Array(0), sampleRate: 16_000 }),
  }
  const truncated = wavs.mono16k.subarray(0, wavs.mono16k.length - 1000)
  // Only the header matters to the step: it reads the magic bytes.
  const oggVoiceNote = Buffer.concat([
    Buffer.from("OggS\0\x02", "latin1"),
    Buffer.alloc(58),
    Buffer.from("OpusHead", "ascii"),
  ])
  const mp3 = Buffer.concat([
    Buffer.from("ID3\x04", "latin1"),
    Buffer.alloc(64),
  ])

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
              "Fixture for the Muse Speech to Text e2e script; safe to delete.",
          },
        }))
      ).id
    }
    const fields = {
      source: await field("audio url"),
      output: await field("transcript", "longText"),
      route: await field("route"),
    }

    if (!webchat) {
      throw new Error("Fixture Webchat was not created.")
    }

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { contact, contactInbox } = await contactService.createWithInbox({
      workspaceId,
      input: {
        email: `stt-qa+${runId}@invalid.test`,
        firstName: "STT QA",
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
  const uploaded = new Map<string, string>()
  const uploadFixture = async (
    fileName: string,
    body: Buffer,
    contentType: string,
  ) => {
    const key = `${fileName}|${contentType}`
    const cached = uploaded.get(key)
    if (cached) {
      return cached
    }
    const ctx = await getIntegrationContext({
      workspaceId,
      contactId: contact.id,
      contactInbox,
    })
    assert(ctx, "integration context not found")
    const objectPath = `${ctx.storagePrefix}/stt-qa/${fixture.runId}/${fileName}`
    await ctx.uploader.putObject(objectPath, body, { ContentType: contentType })
    const url = getPublicFileUrl(objectPath, storageUrl)
    uploaded.set(key, url)
    return url
  }
  const missingUrl = `${storageUrl}/stt-qa/does-not-exist-${fixture.runId}.wav`

  /** Asserts a transcript is non-empty and holds most expected phrases. */
  const checkTranscript = (text: string, label = "transcript") => {
    assert(text.trim(), `${label} is empty`)
    const folded = fold(text)
    const hits = speech.expected.filter((phrase) =>
      folded.includes(fold(phrase)),
    )
    const needed = Math.ceil(speech.expected.length / 2)
    assert(
      hits.length >= needed,
      `${label} matched ${hits.length}/${speech.expected.length} expected phrases: "${preview(text)}"`,
    )
    return `"${preview(text, 100)}" (${hits.length}/${speech.expected.length} phrases)`
  }

  let sessionSeq = 0
  const nextSessionId = () => `stt-qa-${fixture.runId}-${sessionSeq++}`

  const callClient = (
    audio: Buffer | Uint8Array<ArrayBuffer>,
    options: {
      key?: string
      sessionId?: string
      languageBias?: MuseVoiceLanguage[]
      keywords?: string[]
      timeoutMs?: number
      fetch?: typeof fetch
    } = {},
  ) =>
    transcribeWithMuse({
      integration: options.key
        ? { auth: { ...(integration.auth as object), secretText: options.key } }
        : integration,
      audio: Buffer.isBuffer(audio) ? toUpload(audio) : audio,
      model: MUSE_TRANSCRIPTION_MODEL,
      languageBias: options.languageBias,
      keywords: options.keywords,
      sessionId: options.sessionId ?? nextSessionId(),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      timeoutMs: options.timeoutMs ?? workerEnv.MUSE_TRANSCRIBE_TIMEOUT_MS,
      fetch: options.fetch,
    })

  const sttStep = (overrides: Partial<SpeechStep> = {}): SpeechStep =>
    AISpeechToTextDefaultFn({
      provider: "muse",
      inputFieldId: fields.source,
      outputFieldId: fields.output,
      ...overrides,
    } as Partial<SpeechStep>)

  const runHandler = (step: SpeechStep = sttStep()) =>
    audit(() =>
      speechToTextOutput({
        contactInbox,
        conversation,
        metadata: undefined,
        sessionId: nextSessionId(),
        step,
      } as Parameters<typeof speechToTextOutput>[0]),
    )

  const handlerOn = async (
    fileName: string,
    body: Buffer,
    contentType: string,
    step?: SpeechStep,
  ) => {
    await setField(
      fields.source,
      await uploadFixture(fileName, body, contentType),
    )
    return runHandler(step)
  }

  // ── Client (live API) ──────────────────────────────────────────────────
  let baseTranscript = ""

  await runTest("client", "16 kHz mono WAV is transcribed", async () => {
    const result = await callClient(wavs.mono16k)
    baseTranscript = result.text
    assert(result.sessionId, "no sessionId in the response")
    assert(
      result.audioDurationMs > 0,
      `audioDurationMs ${result.audioDurationMs}`,
    )
    return `${checkTranscript(result.text)}, ${result.audioDurationMs} ms audio (local ${Math.round(speechSeconds * 1000)} ms)`
  })

  await runTest("client", "24 kHz mono WAV is transcribed", async () => {
    const result = await callClient(wavs.mono24k)
    return checkTranscript(result.text)
  })

  await runTest(
    "client",
    "LIST and odd-sized JUNK chunks before data are accepted",
    async () => {
      inspectMuseWav(toUpload(wavs.withList))
      const result = await callClient(wavs.withList)
      return checkTranscript(result.text)
    },
  )

  await runTest("client", "languageBias + keywords are accepted", async () => {
    const result = await callClient(wavs.mono16k, {
      languageBias: speech.languageBias.length
        ? speech.languageBias
        : ["English"],
      keywords: KEYWORDS,
    })
    const keywordHits = KEYWORDS.filter((keyword) =>
      fold(result.text).replace(/ /g, "").includes(fold(keyword)),
    )
    return `${checkTranscript(result.text)}, keywords heard: [${keywordHits.join(", ")}]`
  })

  await runTest(
    "client",
    "A reused sessionId is accepted (BullMQ retry)",
    async () => {
      const sessionId = nextSessionId()
      const first = await callClient(wavs.mono16k, { sessionId })
      const retry = await callClient(wavs.mono16k, { sessionId })
      checkTranscript(first.text, "first attempt")
      checkTranscript(retry.text, "retry")
      return `both succeeded; Meta sessionIds ${first.sessionId} / ${retry.sessionId}`
    },
  )

  await runTest("client", "Invalid key is a non-retryable 401", async () => {
    try {
      await callClient(wavs.mono16k, { key: "stt-qa-invalid-key" })
    } catch (error) {
      assert(
        error instanceof MuseTranscribeError,
        `unexpected error: ${String(error)}`,
      )
      assert(
        error.status === 401 || error.status === 403,
        `status ${error.status} (${error.code}): ${error.message}`,
      )
      assert(!isRetryableHeavyError(error), "an auth failure would be retried")
      return `${error.status} ${error.code}: ${preview(error.message, 80)}`
    }
    throw new Error("call with an invalid key succeeded")
  })

  await runTest("client", "A timeout is a retryable failure", async () => {
    try {
      await callClient(wavs.mono16k, { timeoutMs: 1 })
    } catch (error) {
      assert(
        error instanceof MuseTranscribeError,
        `unexpected error: ${String(error)}`,
      )
      assert(error.code === "network_error", `code ${error.code}`)
      assert(isRetryableHeavyError(error), "a timeout would not be retried")
      return `${error.code}, retryable`
    }
    throw new Error("a 1 ms timeout succeeded")
  })

  await runTest(
    "client",
    "An oversized request is refused before calling Meta",
    async () => {
      let called = false
      try {
        await callClient(new Uint8Array(MUSE_TRANSCRIBE_MAX_REQUEST_BYTES), {
          fetch: () => {
            called = true
            throw new Error("fetch must not be called")
          },
        })
      } catch (error) {
        assert(!called, "the request reached fetch")
        assert(
          error instanceof MuseTranscribeError,
          `unexpected error: ${String(error)}`,
        )
        assert(error.code === "request_too_large", `code ${error.code}`)
        assert(!isRetryableHeavyError(error), "would be retried")
        return error.message
      }
      throw new Error("an oversized request succeeded")
    },
  )

  // ── Probe: Meta's own validation vs the local WAV check ────────────────
  const probes = [
    ["stereo 16 kHz", wavs.stereo],
    ["mono 44.1 kHz", wavs.mono44k],
    ["mono 8 kHz", wavs.mono8k],
    ["8-bit mono 16 kHz", wavs.eightBit],
    ["float32 mono 16 kHz", wavs.float32],
    ["WAVE_FORMAT_EXTENSIBLE mono 16 kHz", wavs.extensible],
    ["streaming-size header 16 kHz", wavs.streaming],
    ["ogg voice note", oggVoiceNote],
  ] as const
  for (const [name, bytes] of probes) {
    await runTest("probe", `Meta on ${name}`, async () => {
      let local = "accepted"
      try {
        inspectMuseWav(toUpload(bytes))
      } catch (error) {
        if (!(error instanceof MuseWavFormatError)) {
          throw error
        }
        local = `rejected (${error.reason})`
      }
      try {
        const result = await callClient(bytes)
        const stricter =
          local === "accepted" ? "" : " — local check is stricter than Meta"
        return `local ${local}; Meta accepted: "${preview(result.text, 60)}"${stricter}`
      } catch (error) {
        assert(
          error instanceof MuseTranscribeError,
          `unexpected error: ${String(error)}`,
        )
        assert(
          !error.retryable,
          `Meta rejected it with retryable ${error.status ?? error.code}: a bad file would be retried`,
        )
        assert(
          local !== "accepted",
          `the local check accepts this file but Meta rejects it: ${error.message}`,
        )
        return `local ${local}; Meta ${error.status ?? error.code}: ${preview(error.message, 80)}`
      }
    })
  }

  // ── Handler (real storage) ─────────────────────────────────────────────
  await runTest(
    "handler",
    "16 kHz WAV (audio/wav) is transcribed",
    async () => {
      const text = await handlerOn("speech-16k.wav", wavs.mono16k, "audio/wav")
      assert(text === text.trim(), "transcript is not trimmed")
      return checkTranscript(text)
    },
  )

  await runTest(
    "handler",
    "24 kHz WAV served as application/octet-stream is transcribed",
    async () => {
      const text = await handlerOn(
        "speech-24k.bin",
        wavs.mono24k,
        "application/octet-stream",
      )
      return checkTranscript(text)
    },
  )

  await runTest("handler", "WAV with a LIST chunk is transcribed", async () => {
    const text = await handlerOn(
      "speech-list.wav",
      wavs.withList,
      "audio/x-wav",
    )
    return checkTranscript(text)
  })

  await runTest(
    "handler",
    "languageBias + keywords from the step are sent",
    async () => {
      const text = await handlerOn(
        "speech-16k.wav",
        wavs.mono16k,
        "audio/wav",
        sttStep({
          languageBias: speech.languageBias.length
            ? speech.languageBias
            : undefined,
          keywords: KEYWORDS,
        }),
      )
      return checkTranscript(text)
    },
  )

  // ── Errors (never reach Meta) ──────────────────────────────────────────
  const expectStepError = async (
    load: () => Promise<string> | string,
    expected: RegExp[],
  ): Promise<string> => {
    await setField(fields.source, await load())
    try {
      const text = await runHandler()
      throw new Error(`the step succeeded with "${preview(text, 60)}"`)
    } catch (error) {
      assert(
        error instanceof ExpectedHeavyStepError,
        `not an expected step error: ${String(error)}`,
      )
      assert(!isRetryableHeavyError(error), "the error would be retried")
      for (const pattern of expected) {
        assert(pattern.test(error.message), `message "${error.message}"`)
      }
      return `"${preview(error.message)}"`
    }
  }

  const errorCases: [string, () => Promise<string> | string, RegExp[]][] = [
    [
      "WhatsApp ogg voice note (audio/ogg) is unsupported",
      () => uploadFixture("voice.ogg", oggVoiceNote, "audio/ogg"),
      [UNSUPPORTED_FORMAT_ERROR],
    ],
    [
      "ogg bytes served as octet-stream fail the WAV check",
      () =>
        uploadFixture("voice.bin", oggVoiceNote, "application/octet-stream"),
      [FORMAT_HINT, /not a RIFF/],
    ],
    [
      "mp3 (audio/mpeg) is unsupported",
      () => uploadFixture("voice.mp3", mp3, "audio/mpeg"),
      [UNSUPPORTED_FORMAT_ERROR],
    ],
    [
      "Stereo WAV is rejected",
      () => uploadFixture("stereo.wav", wavs.stereo, "audio/wav"),
      [FORMAT_HINT, /2 channels/],
    ],
    [
      "44.1 kHz WAV is rejected",
      () => uploadFixture("44k.wav", wavs.mono44k, "audio/wav"),
      [FORMAT_HINT, /44100 Hz/],
    ],
    [
      "8-bit WAV is rejected",
      () => uploadFixture("8bit.wav", wavs.eightBit, "audio/wav"),
      [FORMAT_HINT, /8-bit/],
    ],
    [
      "Float WAV is rejected",
      () => uploadFixture("float.wav", wavs.float32, "audio/wav"),
      [FORMAT_HINT, /audio format is 3/],
    ],
    [
      "WAVE_FORMAT_EXTENSIBLE is rejected",
      () => uploadFixture("extensible.wav", wavs.extensible, "audio/wav"),
      [FORMAT_HINT, /audio format is 65534/],
    ],
    [
      "WAV without samples is rejected",
      () => uploadFixture("empty.wav", wavs.empty, "audio/wav"),
      [FORMAT_HINT, /no audio data/],
    ],
    [
      "Truncated WAV is rejected",
      () => uploadFixture("truncated.wav", truncated, "audio/wav"),
      [FORMAT_HINT, /declares/],
    ],
    ["Missing object fails cleanly", () => missingUrl, [MISSING_OBJECT_ERROR]],
    [
      "Private-network URL is refused",
      () => "http://127.0.0.1:9/audio.wav",
      [UNSAFE_URL_ERROR],
    ],
    ["Empty audio field is rejected", () => "", [EMPTY_FIELD_ERROR]],
  ]
  for (const [name, load, expected] of errorCases) {
    await runTest("errors", name, () => expectStepError(load, expected))
  }

  // ── Limits ─────────────────────────────────────────────────────────────
  const limitTest = (
    name: string,
    fn: () => Promise<string>,
    timeoutMs = TEST_TIMEOUT_MS,
  ) =>
    runTest(
      "limits",
      name,
      () => (quick ? Promise.reject(new SkipTest("--quick")) : fn()),
      timeoutMs,
    )

  await limitTest(
    "Exactly 10 min of 24 kHz mono is transcribed",
    async () => {
      const { samples, repeats } = fillTo(
        pcm24k,
        24_000,
        MUSE_TRANSCRIBE_MAX_SECONDS,
      )
      const wav = encodeWav({ samples, sampleRate: 24_000 })
      assert(
        wav.length <= workerEnv.MUSE_TRANSCRIBE_MAX_AUDIO_BYTES,
        `${wav.length} bytes is over the download cap`,
      )
      const startedAt = performance.now()
      const text = await handlerOn("long-600s.wav", wav, "audio/wav")
      const seconds = Math.round((performance.now() - startedAt) / 1000)
      checkTranscript(text)
      // Each repeat should land in the transcript; allow for dropped ones.
      assert(
        !baseTranscript || text.length >= baseTranscript.length * repeats * 0.5,
        `transcript is ${text.length} chars for ${repeats} repeats of ${baseTranscript.length}`,
      )
      return `${(wav.length / 1024 / 1024).toFixed(1)} MB, ${repeats} repeats → ${text.length} chars in ${seconds} s`
    },
    LONG_TIMEOUT_MS,
  )

  await limitTest("10 min + 1 s is refused before Meta", () =>
    expectStepError(
      () =>
        uploadFixture(
          "long-601s.wav",
          encodeWav({
            samples: fillTo(pcm24k, 24_000, MUSE_TRANSCRIBE_MAX_SECONDS + 1)
              .samples,
            sampleRate: 24_000,
          }),
          "audio/wav",
        ),
      [FORMAT_HINT, TOO_LONG_ERROR],
    ),
  )

  await limitTest(
    "A body over MUSE_TRANSCRIBE_MAX_AUDIO_BYTES is refused",
    () => {
      const seconds = Math.ceil(
        workerEnv.MUSE_TRANSCRIBE_MAX_AUDIO_BYTES / (24_000 * 2),
      )
      return expectStepError(
        () =>
          uploadFixture(
            "oversize.wav",
            encodeWav({
              samples: fillTo(pcm24k, 24_000, seconds + 1).samples,
              sampleRate: 24_000,
            }),
            "audio/wav",
          ),
        [TOO_LARGE_ERROR],
      )
    },
  )

  // ── Flow through the queues ────────────────────────────────────────────
  const buildFlowGraph = (step: SpeechStep) => {
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
      dataProps: { name: `${prefix} | transcribe`, isStartNode: true },
    })
    start.data.details.steps = [step]
    const routes = {
      success: routeNode("transcribed", 150),
      error: routeNode("failed", 450),
    }
    const edges = (step.states ?? []).map((state) => {
      const targetNode = routes[state.stateType as keyof typeof routes]
      return {
        id: createId(),
        source: start.id,
        sourceHandle: state.id,
        target: targetNode.id,
        targetHandle: targetNode.id,
      }
    })
    return {
      nodes: [start, routes.success, routes.error],
      edges,
      startNodeId: start.id,
    }
  }

  const runFlow = async (name: string, audioUrl: string) => {
    if (!withWorkers) {
      throw new SkipTest("pass --with-workers with the worker running")
    }
    const { id: flowId } = await audit(() =>
      flowService.createPublished({
        workspaceId,
        data: { name: `${prefix} | ${name} | ${fixture.runId}` },
        graph: buildFlowGraph(sttStep()),
      }),
    )
    createdFlowIds.push(flowId)
    await setField(fields.source, audioUrl)
    await setField(fields.output, "")
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
      { jobId: `stt-qa-${fixture.runId}-${flowId}` },
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
    "A WAV routes success and writes the transcript",
    async () => {
      const url = await uploadFixture(
        "speech-16k.wav",
        wavs.mono16k,
        "audio/wav",
      )
      const { flowId, route } = await runFlow("success", url)
      assert(route === "transcribed", `routed "${route}"`)
      const text = await readField(fields.output)
      return `flow ${flowId}: ${checkTranscript(text ?? "", "output field")}`
    },
    FLOW_TIMEOUT_MS,
  )

  await runTest(
    "flow",
    "A WhatsApp ogg voice note routes error",
    async () => {
      const url = await uploadFixture("voice.ogg", oggVoiceNote, "audio/ogg")
      const { flowId, route } = await runFlow("ogg", url)
      assert(route === "failed", `routed "${route}"`)
      const text = await readField(fields.output)
      assert(!text, `output field was written: "${preview(text)}"`)
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

  const apiGraph = (step: SpeechStep) => {
    const { nodes, edges } = buildFlowGraph(step)
    return { nodes, edges }
  }

  await runTest("api", "Public spec exposes the Muse branch", async () => {
    const { status, text } = await api("GET", "/public-spec.json")
    assert(status === 200, `status ${status}`)
    for (const needle of [
      '"aiSpeechToText"',
      `"${MUSE_TRANSCRIPTION_MODEL}"`,
      '"languageBias"',
    ]) {
      assert(text.includes(needle), `${needle} not in spec`)
    }
    return "aiSpeechToText + muse model + languageBias present"
  })

  await runTest(
    "api",
    "A flow with the Muse step can be published",
    async () => {
      const { status, text } = await api("POST", "/v1/flows", {
        name: `${prefix} | api | ${fixture.runId}`,
        folderId: null,
        ...apiGraph(
          sttStep({ languageBias: ["Vietnamese"], keywords: KEYWORDS }),
        ),
        publish: true,
      })
      assert(
        status === 200 || status === 201,
        `status ${status}: ${preview(text)}`,
      )
      const { id } = JSON.parse(text) as { id: string }
      createdFlowIds.push(id)
      return `flow ${id}`
    },
  )

  const invalidSteps: [string, SpeechStep, string][] = [
    [
      "An unknown languageBias is rejected",
      { ...sttStep(), languageBias: ["Klingon"] } as never,
      "languageBias",
    ],
    [
      "Keywords on an OpenAI step are rejected",
      {
        ...AISpeechToTextDefaultFn({
          inputFieldId: fields.source,
          outputFieldId: fields.output,
        }),
        keywords: KEYWORDS,
      } as never,
      "keywords",
    ],
    [
      "Another model on a Muse step is rejected",
      { ...sttStep(), model: "whisper-1" } as never,
      "model",
    ],
  ]
  for (const [name, step, needle] of invalidSteps) {
    await runTest("api", name, async () => {
      const { status, text } = await api("POST", "/v1/flows", {
        name: `${prefix} | api invalid | ${fixture.runId}`,
        folderId: null,
        ...apiGraph(step),
        publish: true,
      })
      assert(status >= 400 && status < 500, `status ${status}`)
      assert(text.includes(needle), `body ${preview(text)}`)
      return `${status} ${preview(text, 80)}`
    })
  }

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
        speech: { source: speech.source, seconds: speechSeconds },
        fixture: {
          webchatId: fixture.webchat.id,
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
  if (createdFlowIds.length > 0 && !keepFlows) {
    await audit(() =>
      flowService.deleteMany({ workspaceId, ids: createdFlowIds }),
    ).catch((error: unknown) =>
      console.warn(`Could not delete QA flows: ${String(error)}`),
    )
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}
