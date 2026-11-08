import {
  type SourceAuthoringEnvelopeV1,
  sourceAuthoringEnvelopeV1Schema,
} from "@chatbotx.io/flow-config"
import { z } from "zod"
import {
  type MessageFieldSurface,
  messageFieldHashSchema,
  messageFieldSurfaceSchema,
} from "./message-field-surface"
import { MessageAuthoringRejected } from "./port"
import {
  type MessageFieldEdit,
  type MessageLiteralView,
  type MessageLiteralViewRequest,
  type MessageLiteralWrite,
  messageFieldEditSchema,
  messageLiteralViewRequestSchema,
  messageLiteralViewSchema,
  messageLiteralWriteSchema,
} from "./wire"

/** Только HTTP 409/422 являются подтверждённым отказом owner, остальные исходы не расширяют его ABI. */
export class MessageFieldHttpError extends Error {
  readonly code: "invalid_request" | "unauthorized" | "unknown"
  constructor(code: MessageFieldHttpError["code"]) {
    super(code)
    this.name = "MessageFieldHttpError"
    this.code = code
  }
}
function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: "invalid_request" | "unknown",
): T {
  try {
    const parsed = schema.safeParse(value)
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Исключение валидатора не раскрывает submitted input или ответ сервера.
  }
  throw new MessageFieldHttpError(code)
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  return parse(schema, value, "invalid_request")
}

function sameTarget(
  left: MessageLiteralView["target"],
  right: MessageLiteralView["target"],
): boolean {
  return (
    left.scenario_id === right.scenario_id &&
    left.block_id === right.block_id &&
    left.path === right.path &&
    left.start === right.start &&
    left.end === right.end &&
    left.sequence === right.sequence
  )
}

/** Узкий same-origin transport. Ни auto retry, ни service key, ни runtime effects здесь нет. */
export class MessageFieldHttpClient {
  private readonly request: typeof fetch
  constructor(request: typeof fetch = fetch) {
    this.request = (input, init) => request(input, init)
  }

  async surface(
    botId: string,
    signal?: AbortSignal,
  ): Promise<MessageFieldSurface> {
    const json = await this.call(botId, "", undefined, signal)
    return parse(messageFieldSurfaceSchema, json, "unknown")
  }

  /** Raw hash проверяется локально и не добавляется в frozen view request. */
  async view(
    botId: string,
    request: MessageLiteralViewRequest,
    expectedSourceHash: string,
  ): Promise<MessageLiteralView> {
    const body = input(messageLiteralViewRequestSchema, request)
    input(messageFieldHashSchema, body.expected_full_ir_id)
    input(messageFieldHashSchema, expectedSourceHash)
    const view = await this.readView(botId, "view", body)
    this.exactPin(
      view,
      body.field_id,
      body.expected_full_ir_id,
      expectedSourceHash,
      body.expected_draft_version,
    )
    return view
  }

  async slot(
    botId: string,
    write: MessageLiteralWrite,
  ): Promise<MessageLiteralView> {
    const body = input(messageLiteralWriteSchema, write)
    input(messageFieldHashSchema, body.expected_full_ir_id)
    input(messageFieldHashSchema, body.expected_source_hash)
    const view = await this.readView(botId, "slot", body)
    this.exactPin(
      view,
      body.field_id,
      body.expected_full_ir_id,
      body.expected_source_hash,
      body.expected_draft_version,
    )
    if (
      !sameTarget(view.target, body.target) ||
      view.handler_id !== body.handler_id ||
      view.policy_revision !== body.policy_revision ||
      view.descriptor_version !== body.descriptor_version ||
      view.schema_ref !== body.schema_ref ||
      view.text !== body.text
    ) {
      throw new MessageFieldHttpError("unknown")
    }
    return view
  }

  async compile(
    botId: string,
    edit: MessageFieldEdit,
  ): Promise<SourceAuthoringEnvelopeV1> {
    const body = input(messageFieldEditSchema, edit)
    input(messageFieldHashSchema, body.expected_full_ir_id)
    input(messageFieldHashSchema, body.expected_source_hash)
    const json = await this.call(botId, "compile", body)
    const envelope = parse(sourceAuthoringEnvelopeV1Schema, json, "unknown")
    if (
      envelope.draft_version !== body.expected_draft_version + 1 ||
      !envelope.logic ||
      !messageFieldHashSchema.safeParse(envelope.source_hash).success ||
      !messageFieldHashSchema.safeParse(envelope.source_revision).success
    ) {
      throw new MessageFieldHttpError("unknown")
    }
    return envelope
  }

  private exactPin(
    view: MessageLiteralView,
    fieldId: string,
    pin: string,
    hash: string,
    draft: number,
  ): void {
    if (
      view.field_id !== fieldId ||
      view.source_revision !== pin ||
      view.source_hash !== hash ||
      view.draft_version !== draft
    ) {
      throw new MessageFieldHttpError("unknown")
    }
  }
  private async readView(
    botId: string,
    action: "view" | "slot",
    body: MessageLiteralViewRequest | MessageLiteralWrite,
  ): Promise<MessageLiteralView> {
    const json = await this.call(botId, action, body)
    return parse(messageLiteralViewSchema, json, "unknown")
  }
  private async call(
    botId: string,
    action: "" | "view" | "slot" | "compile",
    body?: MessageLiteralViewRequest | MessageLiteralWrite | MessageFieldEdit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    input(z.uuid(), botId)
    const path = `/api/automation/bots/${botId}/source-runtime/message-fields${action ? `/${action}` : ""}`
    let response: Response
    try {
      response = await this.request(
        path,
        action
          ? {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              signal,
            },
      )
    } catch {
      throw new MessageFieldHttpError("unknown")
    }
    if (response.status === 401 || response.status === 403) {
      throw new MessageFieldHttpError("unauthorized")
    }
    if (response.status === 409) {
      throw new MessageAuthoringRejected("conflict")
    }
    if (response.status === 422) {
      throw new MessageAuthoringRejected("validation_rejected")
    }
    if (response.status !== 200) {
      throw new MessageFieldHttpError("unknown")
    }
    try {
      return await response.json()
    } catch {
      throw new MessageFieldHttpError("unknown")
    }
  }
}
