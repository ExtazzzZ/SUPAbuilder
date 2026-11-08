"use client"

import { useEffect, useRef, useState } from "react"

/** Локальная модель формы, не wire DTO. Допуск и безопасный текст проверяет родитель. */
export interface OrdinaryMessageFormProps {
  commitBlocked?: boolean
  editable: boolean
  fieldId: string
  label: string
  labels: {
    save: string
    saving: string
    saveError: string
    readOnly: string
  }
  onCommit: (text: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  pending: boolean
  readOnlyReason?: string
  text: string
}

/** Показывает только обычный текст разрешённого поля, без интерпретации разметки. */
export function OrdinaryMessageForm(properties: OrdinaryMessageFormProps) {
  if (!properties.editable) {
    return (
      <section aria-label={properties.label}>
        <p>{properties.label}</p>
        <p>{properties.readOnlyReason ?? properties.labels.readOnly}</p>
      </section>
    )
  }
  return (
    <EditableOrdinaryMessageForm key={properties.fieldId} {...properties} />
  )
}

function EditableOrdinaryMessageForm({
  fieldId,
  label,
  text,
  editable,
  commitBlocked,
  pending,
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
    if (!editable || commitBlocked || pending || inFlight.current) {
      return
    }
    inFlight.current = true
    setSaving(true)
    setFailed(false)
    try {
      await onCommit(draft)
    } catch {
      // Ошибка любого типа оставляет черновик; повтор возможен только новой кнопкой.
      setFailed(true)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  return (
    <section aria-label={label} className="flex flex-col gap-3">
      <label htmlFor={fieldId}>{label}</label>
      <textarea
        disabled={pending || saving}
        id={fieldId}
        name={fieldId}
        onChange={(event) => setDraft(event.target.value)}
        value={draft}
      />
      <button
        aria-label={labels.save}
        disabled={commitBlocked || pending || saving}
        onClick={commit}
        type="button"
      >
        {saving || pending ? labels.saving : labels.save}
      </button>
      {failed && <p role="alert">{labels.saveError}</p>}
    </section>
  )
}
