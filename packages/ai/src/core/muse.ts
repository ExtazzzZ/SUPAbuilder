import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible"

export const MUSE_BASE_URL = "https://api.meta.ai/v1"

/**
 * Muse counts reasoning tokens against `max_tokens`. With the model's default
 * effort a short budget (e.g. the 250-token `aiGenerateText` default or the
 * 128-token handoff classifier) is spent entirely on reasoning and the reply
 * comes back empty. Below this budget the factory picks `minimal` effort.
 */
export const MUSE_LOW_BUDGET_THRESHOLD = 1024

/**
 * Extra `max_tokens` reserved for reasoning so a call site's
 * `maxOutputTokens` stays the visible-text budget, as with other providers.
 * `max_tokens` is a ceiling — only generated tokens are billed.
 */
export const MUSE_REASONING_HEADROOM_TOKENS = 1024

/**
 * Highest temperature sent to Muse. Steps and agents allow up to 2, but at 2
 * every Muse model either reasons until the budget is gone (empty reply) or
 * returns a 500; replies stay normal up to 1.
 */
export const MUSE_MAX_TEMPERATURE = 1

export function transformMuseRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const maxTokens =
    typeof body.max_tokens === "number" ? body.max_tokens : undefined
  const next = { ...body }

  // The SDK always sets the key (value `undefined` when no effort is passed),
  // so check the value, not `"reasoning_effort" in body`.
  if (next.reasoning_effort == null) {
    next.reasoning_effort =
      maxTokens !== undefined && maxTokens < MUSE_LOW_BUDGET_THRESHOLD
        ? "minimal"
        : "low"
  }

  if (maxTokens !== undefined) {
    next.max_tokens = maxTokens + MUSE_REASONING_HEADROOM_TOKENS
  }

  if (
    typeof next.temperature === "number" &&
    next.temperature > MUSE_MAX_TEMPERATURE
  ) {
    next.temperature = MUSE_MAX_TEMPERATURE
  }

  return next
}

export function createMuse(
  options: Pick<OpenAICompatibleProviderSettings, "apiKey" | "fetch"> = {},
) {
  return createOpenAICompatible({
    name: "muse",
    baseURL: MUSE_BASE_URL,
    apiKey: options.apiKey,
    fetch: options.fetch,
    includeUsage: true,
    supportsStructuredOutputs: true,
    transformRequestBody: transformMuseRequestBody,
  })
}
