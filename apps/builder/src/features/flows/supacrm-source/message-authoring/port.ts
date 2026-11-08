import type { sourceSpanV1Schema } from "@chatbotx.io/flow-config"
import type { z } from "zod"
import type {
  MessageFieldEdit,
  MessageLiteralView,
  MessageLiteralWrite,
} from "./wire"

/** Внутренние модели адаптера; HTTP envelope/action names ими не определяются. */
export interface MessageFullPin {
  draftVersion: number
  sourceHash: string
  sourceRevision: string
}
export interface MessageFieldScope {
  fieldId: string
  fullPin: MessageFullPin
  sourceKind: string
  target: z.infer<typeof sourceSpanV1Schema>
}
/** Безопасный field item server surface; отсутствующие owner/evidence не выдумываются. */
export interface MessageSurfaceField {
  code: string
  descriptor_version?: string
  editable: boolean
  field_id: string
  handler_id?: string
  policy_revision?: string
  schema_ref?: string
  target: z.infer<typeof sourceSpanV1Schema>
}
export interface MessageFieldRead {
  field: MessageSurfaceField
  view?: MessageLiteralView
}
export interface MessageAuthoringPort {
  compileField: (edit: MessageFieldEdit) => Promise<MessageFullPin>
  readField: (
    fieldId: string,
    fullPin: MessageFullPin,
  ) => Promise<MessageFieldRead>
  writeLiteral: (write: MessageLiteralWrite) => Promise<MessageLiteralView>
}
/** Только подтверждённый отказ допускает повтор; любые иные исключения неизвестны. */
export class MessageAuthoringRejected extends Error {
  readonly code: "validation_rejected" | "conflict"
  constructor(code: "validation_rejected" | "conflict") {
    super(code)
    this.code = code
  }
}
