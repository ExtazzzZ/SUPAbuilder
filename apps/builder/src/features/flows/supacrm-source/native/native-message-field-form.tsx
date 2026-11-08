"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { useEffect, useRef, useState } from "react"
import type { OrdinaryMessageFormProps } from "../message-authoring/ordinary-message-form"

/** Нативные контролы ordinary literal без TipTap, RHF и legacy persistence. */
export function NativeMessageFieldForm(properties: OrdinaryMessageFormProps) {
  if (!properties.editable) {
    return (
      <div>
        <p>{properties.label}</p>
        <p>{properties.readOnlyReason ?? properties.labels.readOnly}</p>
      </div>
    )
  }
  return (
    <EditableNativeMessageFieldForm key={properties.fieldId} {...properties} />
  )
}
function EditableNativeMessageFieldForm({
  fieldId,
  label,
  text,
  pending,
  commitBlocked,
  labels,
  onCommit,
  onDirtyChange,
}: OrdinaryMessageFormProps) {
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  useEffect(() => {
    onDirtyChange?.(draft !== text)
  }, [draft, text, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const commit = async () => {
    if (pending || commitBlocked || inFlight.current) {
      return
    }
    inFlight.current = true
    setSaving(true)
    setFailed(false)
    try {
      await onCommit(draft)
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor={fieldId}>{label}</Label>
      <Textarea
        disabled={pending || saving}
        id={fieldId}
        name={fieldId}
        onChange={(event) => setDraft(event.target.value)}
        value={draft}
      />
      <Button
        aria-label={labels.save}
        disabled={pending || saving || commitBlocked}
        onClick={commit}
        type="button"
      >
        {pending || saving ? labels.saving : labels.save}
      </Button>
      {failed && (
        <p className="text-destructive text-sm" role="alert">
          {labels.saveError}
        </p>
      )}
    </div>
  )
}
