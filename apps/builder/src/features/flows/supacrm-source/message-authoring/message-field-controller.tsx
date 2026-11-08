"use client"

import { sourceSpanV1Schema } from "@chatbotx.io/flow-config"
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { z } from "zod"
import {
  OrdinaryMessageForm,
  type OrdinaryMessageFormProps,
} from "./ordinary-message-form"
import {
  type MessageAuthoringPort,
  MessageAuthoringRejected,
  type MessageFieldScope,
  type MessageFullPin,
} from "./port"
import {
  type MessageLiteralView,
  messageFieldEditSchema,
  messageLiteralViewSchema,
  messageLiteralWriteSchema,
} from "./wire"

// Локальная проверка safe surface item; это не RegisteredOwnerDescriptor и не wire envelope.
const eligibleFieldSchema = z.strictObject({
  field_id: z.string(),
  target: sourceSpanV1Schema,
  editable: z.literal(true),
  code: z.string(),
  handler_id: z.literal("source-presentation/1"),
  policy_revision: z.string().min(1),
  descriptor_version: z.string(),
  schema_ref: z.literal("source.message.plain-text/1"),
})
type EligibleField = z.infer<typeof eligibleFieldSchema>
type Loaded = { field: EligibleField; view: MessageLiteralView }
export interface MessageFieldControllerProps {
  formComponent?: ComponentType<OrdinaryMessageFormProps>
  label: string
  labels: OrdinaryMessageFormProps["labels"] & {
    reload: string
    loading: string
    unknown: string
  }
  onCompiled: (pin: MessageFullPin) => void
  onDirtyChange?: (dirty: boolean) => void
  onMutationEnd?: () => void
  onMutationStart?: () => boolean
  onReloadRequested: () => Promise<void>
  onUnknownChange?: (unknown: boolean) => void
  port: MessageAuthoringPort
  renderReload?: (properties: {
    label: string
    disabled: boolean
    onClick: () => Promise<void>
  }) => ReactNode
  scope: MessageFieldScope
}
const pinSchema = z.strictObject({
  sourceRevision: z.string().min(1),
  sourceHash: z.string().min(1),
  draftVersion: z.number().int().nonnegative(),
})
function sameSpan(
  left: MessageFieldScope["target"],
  right: MessageFieldScope["target"],
) {
  return (
    left.scenario_id === right.scenario_id &&
    left.block_id === right.block_id &&
    left.path === right.path &&
    left.start === right.start &&
    left.end === right.end &&
    left.sequence === right.sequence
  )
}
function eligible(field: EligibleField, scope: MessageFieldScope) {
  return (
    field.field_id === scope.fieldId &&
    sameSpan(field.target, scope.target) &&
    scope.sourceKind === "send_message" &&
    field.target.path === "params.markup"
  )
}
function validView(
  view: MessageLiteralView,
  field: EligibleField,
  pin: MessageFullPin,
) {
  return (
    view.field_id === field.field_id &&
    sameSpan(view.target, field.target) &&
    view.source_revision === pin.sourceRevision &&
    view.source_hash === pin.sourceHash &&
    view.draft_version === pin.draftVersion &&
    view.handler_id === field.handler_id &&
    view.policy_revision === field.policy_revision &&
    view.descriptor_version === field.descriptor_version &&
    view.schema_ref === field.schema_ref &&
    view.slot.declared_type === "str"
  )
}

/** Привязка только к проверенному ordinary owner; port не задаёт сетевой протокол. */
export function MessageFieldController(
  properties: MessageFieldControllerProps,
) {
  const { scope } = properties
  const key = JSON.stringify([
    scope.fieldId,
    scope.sourceKind,
    scope.target.scenario_id,
    scope.target.block_id,
    scope.target.path,
    scope.target.start,
    scope.target.end,
    scope.target.sequence,
    scope.fullPin.sourceRevision,
    scope.fullPin.sourceHash,
    scope.fullPin.draftVersion,
  ])
  return <ScopedMessageFieldController key={key} {...properties} />
}
function ScopedMessageFieldController({
  scope,
  port,
  label,
  labels,
  onCompiled,
  onReloadRequested,
  onDirtyChange,
  onUnknownChange,
  onMutationStart,
  onMutationEnd,
  formComponent: FormComponent = OrdinaryMessageForm,
  renderReload,
}: MessageFieldControllerProps) {
  const initialScope = useRef(scope)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = useRef<Loaded | null>(null)
  const pin = useRef(scope.fullPin)
  const [pending, setPending] = useState(true)
  const [blocked, setBlocked] = useState(false)
  const blockRef = useRef(false)
  const busy = useRef(false)
  const generation = useRef(0)
  const [formVersion, setFormVersion] = useState(0)
  useEffect(() => {
    onUnknownChange?.(blocked)
  }, [blocked, onUnknownChange])
  useEffect(() => () => onUnknownChange?.(false), [onUnknownChange])
  const reload = useCallback(async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    const request = ++generation.current
    try {
      const selectedScope = initialScope.current
      const response = await port.readField(
        selectedScope.fieldId,
        selectedScope.fullPin,
      )
      if (request !== generation.current) {
        return
      }
      const parsedField = eligibleFieldSchema.safeParse(response.field)
      if (
        !(
          parsedField.success &&
          eligible(parsedField.data, selectedScope) &&
          response.view
        )
      ) {
        current.current = null
        setLoaded(null)
        return
      }
      const field = parsedField.data
      const view = messageLiteralViewSchema.parse(response.view)
      if (!validView(view, field, selectedScope.fullPin)) {
        throw new Error("field_scope_mismatch")
      }
      current.current = { field, view }
      pin.current = {
        ...selectedScope.fullPin,
        draftVersion: view.draft_version,
      }
      setLoaded(current.current)
      blockRef.current = false
      setBlocked(false)
      setFormVersion((version) => version + 1)
    } catch {
      if (request === generation.current) {
        blockRef.current = true
        setBlocked(true)
      }
    } finally {
      if (request === generation.current) {
        busy.current = false
        setPending(false)
      }
    }
  }, [port])
  useEffect(() => {
    reload()
    return () => {
      generation.current++
      busy.current = false
    }
  }, [reload])
  const commit = async (text: string) => {
    const active = current.current
    if (!active || busy.current || blockRef.current) {
      throw new MessageAuthoringRejected("conflict")
    }
    if (onMutationStart && !onMutationStart()) {
      throw new MessageAuthoringRejected("conflict")
    }
    busy.current = true
    const request = generation.current
    setPending(true)
    try {
      const field = active.field
      const common = {
        field_id: field.field_id,
        target: field.target,
        handler_id: field.handler_id,
        policy_revision: field.policy_revision,
        descriptor_version: field.descriptor_version,
        schema_ref: field.schema_ref,
        expected_full_ir_id: pin.current.sourceRevision,
        expected_source_hash: pin.current.sourceHash,
        expected_draft_version: pin.current.draftVersion,
      }
      const proposed = messageLiteralWriteSchema.safeParse({ ...common, text })
      if (!proposed.success) {
        throw new MessageAuthoringRejected("validation_rejected")
      }
      const granted = messageLiteralViewSchema.parse(
        await port.writeLiteral(proposed.data),
      )
      if (request !== generation.current) {
        throw new Error("field_scope_changed")
      }
      if (!validView(granted, field, pin.current) || granted.text !== text) {
        throw new Error("field_scope_mismatch")
      }
      pin.current = { ...pin.current, draftVersion: granted.draft_version }
      current.current = { field, view: granted }
      const edit = messageFieldEditSchema.parse({
        ...common,
        expected_draft_version: granted.draft_version,
        template: { context: "text", runs: [granted.slot] },
      })
      const compiled = pinSchema.parse(await port.compileField(edit))
      if (request !== generation.current) {
        throw new Error("field_scope_changed")
      }
      if (compiled.draftVersion !== granted.draft_version + 1) {
        throw new Error("field_scope_mismatch")
      }
      pin.current = compiled
      onCompiled(compiled)
    } catch (error) {
      if (!(error instanceof MessageAuthoringRejected)) {
        blockRef.current = true
        setBlocked(true)
      }
      throw new MessageAuthoringRejected(
        error instanceof MessageAuthoringRejected ? error.code : "conflict",
      )
    } finally {
      busy.current = false
      setPending(false)
      onMutationEnd?.()
    }
  }
  const requestReload = async () => {
    if (!blockRef.current) {
      return reload()
    }
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    try {
      // Неизвестный compile мог сменить canonical pin: refresh принадлежит родителю.
      await onReloadRequested()
    } catch {
      blockRef.current = true
      setBlocked(true)
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <div>
      {loaded ? (
        <FormComponent
          commitBlocked={blocked}
          editable
          fieldId={scope.fieldId}
          key={formVersion}
          label={label}
          labels={labels}
          onCommit={commit}
          onDirtyChange={onDirtyChange}
          pending={pending}
          text={loaded.view.text}
        />
      ) : (
        <p>{pending ? labels.loading : labels.readOnly}</p>
      )}
      {blocked && <p role="status">{labels.unknown}</p>}
      {renderReload ? (
        renderReload({
          label: labels.reload,
          disabled: pending,
          onClick: requestReload,
        })
      ) : (
        <button
          aria-label={labels.reload}
          disabled={pending}
          onClick={requestReload}
          type="button"
        >
          {labels.reload}
        </button>
      )}
    </div>
  )
}
