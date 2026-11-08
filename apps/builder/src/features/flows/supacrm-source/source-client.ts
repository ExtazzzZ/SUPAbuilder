import {
  buildSourceAuthoringPatchV1,
  buildSourceLogicCompileRequestV1,
  type SourceAuthoringEnvelopeV1,
  type SourceLogicProjectionV1,
  type SourceProjection,
  sourceAuthoringEnvelopeV1Schema,
} from "@chatbotx.io/flow-config"
import { z } from "zod"

export class SourceAuthoringError extends Error {
  readonly code:
    | "invalid_request"
    | "unavailable"
    | "conflict"
    | "unauthorized"
    | "invalid_response"
    | "save_unconfirmed"
    | "compile_rejected"
    | "publish_blocked"
  readonly diagnostics: { code: string; block_id?: string }[]
  constructor(
    code: SourceAuthoringError["code"],
    diagnostics: SourceAuthoringError["diagnostics"] = [],
  ) {
    super(code)
    this.name = "SourceAuthoringError"
    this.code = code
    this.diagnostics = diagnostics
  }
}

/** Только same-origin management BFF. S2S ключи и authority_ref не принимаются. */
export class SourceAuthoringClient {
  private readonly request: typeof fetch
  constructor(request: typeof fetch = fetch) {
    this.request = (input, init) => request(input, init)
  }

  private path(
    botId: string,
    suffix: "projection" | "draft" | "compile" | "validate" | "publish",
  ) {
    if (!z.uuid().safeParse(botId).success) {
      throw new SourceAuthoringError("invalid_request")
    }
    return `/api/automation/bots/${botId}/source-runtime/${suffix}`
  }

  async load(
    botId: string,
    signal?: AbortSignal,
  ): Promise<SourceAuthoringEnvelopeV1> {
    let response: Response
    try {
      response = await this.request(this.path(botId, "projection"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal,
      })
    } catch (error) {
      if (error instanceof SourceAuthoringError) {
        throw error
      }
      throw new SourceAuthoringError("unavailable")
    }
    return this.envelope(response)
  }

  async save(
    botId: string,
    base: SourceAuthoringEnvelopeV1,
    edited: SourceProjection,
  ): Promise<SourceAuthoringEnvelopeV1> {
    let body: string
    try {
      body = JSON.stringify(buildSourceAuthoringPatchV1(base, edited))
    } catch {
      throw new SourceAuthoringError("invalid_request")
    }
    const path = this.path(botId, "draft")
    let response: Response
    try {
      response = await this.request(path, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
      })
    } catch {
      // Сохранение могло завершиться; повтор CAS возможен только после явной сверки.
      throw new SourceAuthoringError("save_unconfirmed")
    }
    try {
      const next = await this.envelope(response)
      if (
        next.source_revision !== base.source_revision ||
        next.draft_version <= base.draft_version
      ) {
        throw new SourceAuthoringError("save_unconfirmed")
      }
      return next
    } catch (error) {
      if (
        error instanceof SourceAuthoringError &&
        (error.code === "conflict" || error.code === "unauthorized")
      ) {
        throw error
      }
      throw new SourceAuthoringError("save_unconfirmed")
    }
  }

  async compile(
    botId: string,
    base: SourceAuthoringEnvelopeV1,
    logic: SourceLogicProjectionV1,
  ): Promise<SourceAuthoringEnvelopeV1> {
    let body: unknown
    try {
      body = buildSourceLogicCompileRequestV1(base, logic)
    } catch {
      throw new SourceAuthoringError("invalid_request")
    }
    return await this.post(botId, "compile", base, body)
  }

  async validate(
    botId: string,
    base: SourceAuthoringEnvelopeV1,
  ): Promise<SourceAuthoringEnvelopeV1> {
    return await this.post(botId, "validate", base, this.publishBody(base))
  }

  async publish(
    botId: string,
    base: SourceAuthoringEnvelopeV1,
  ): Promise<SourceAuthoringEnvelopeV1> {
    return await this.post(botId, "publish", base, this.publishBody(base))
  }

  private publishBody(base: SourceAuthoringEnvelopeV1) {
    const envelope = sourceAuthoringEnvelopeV1Schema.parse(base)
    return {
      version: "supacrm.source-publish.v1",
      source_revision: envelope.source_revision,
      expected_draft_version: envelope.draft_version,
    }
  }

  private async post(
    botId: string,
    action: "compile" | "validate" | "publish",
    base: SourceAuthoringEnvelopeV1,
    body: unknown,
  ): Promise<SourceAuthoringEnvelopeV1> {
    const path = this.path(botId, action)
    let response: Response
    try {
      response = await this.request(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch {
      throw new SourceAuthoringError(
        action === "validate" ? "unavailable" : "save_unconfirmed",
      )
    }
    try {
      if (action === "compile" && response.status === 422) {
        const rejected = z
          .strictObject({
            version: z.literal("supacrm.source-authoring.v1"),
            diagnostics: z.array(
              z.strictObject({
                code: z.string(),
                block_id: z.string().optional(),
              }),
            ),
            publishable: z.literal(false),
          })
          .safeParse(await response.json())
        if (!rejected.success) {
          throw new SourceAuthoringError("invalid_response")
        }
        throw new SourceAuthoringError(
          "compile_rejected",
          rejected.data.diagnostics,
        )
      }
      if (action === "publish" && response.status === 409) {
        let rejected: unknown
        try {
          rejected = await response.clone().json()
        } catch {
          rejected = null
        }
        const blocked = sourceAuthoringEnvelopeV1Schema.safeParse(rejected)
        if (
          blocked.success &&
          blocked.data.source_revision === base.source_revision
        ) {
          throw new SourceAuthoringError(
            "publish_blocked",
            blocked.data.diagnostics,
          )
        }
      }
      const next = await this.envelope(response)
      if (action === "validate" && next.draft_version !== base.draft_version) {
        throw new SourceAuthoringError("invalid_response")
      }
      if (action === "publish" && next.draft_version < base.draft_version) {
        throw new SourceAuthoringError("invalid_response")
      }
      if (
        action === "compile" &&
        (next.draft_version <= base.draft_version ||
          !next.logic ||
          !next.source_hash)
      ) {
        throw new SourceAuthoringError("invalid_response")
      }
      if (
        action !== "compile" &&
        next.source_revision !== base.source_revision
      ) {
        throw new SourceAuthoringError("invalid_response")
      }
      if (
        action === "publish" &&
        next.published_revision !== base.source_revision
      ) {
        throw new SourceAuthoringError("invalid_response")
      }
      return next
    } catch (error) {
      if (
        error instanceof SourceAuthoringError &&
        [
          "conflict",
          "unauthorized",
          "compile_rejected",
          "publish_blocked",
        ].includes(error.code)
      ) {
        throw error
      }
      throw new SourceAuthoringError(
        action === "validate" ? "invalid_response" : "save_unconfirmed",
      )
    }
  }

  private async envelope(
    response: Response,
  ): Promise<SourceAuthoringEnvelopeV1> {
    if (response.status === 409) {
      throw new SourceAuthoringError("conflict")
    }
    if (response.status === 401 || response.status === 403) {
      throw new SourceAuthoringError("unauthorized")
    }
    if (!response.ok) {
      throw new SourceAuthoringError("unavailable")
    }
    try {
      const parsed = sourceAuthoringEnvelopeV1Schema.safeParse(
        await response.json(),
      )
      if (!parsed.success) {
        throw new SourceAuthoringError("invalid_response")
      }
      return parsed.data
    } catch {
      throw new SourceAuthoringError("invalid_response")
    }
  }
}
