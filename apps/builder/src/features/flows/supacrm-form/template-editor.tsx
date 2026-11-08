"use client"

import type {
  receiptEmailTemplateCandidateSchema,
  receiptEmailTemplateUsageSchema,
} from "@chatbotx.io/business"
import {
  getSupacrmForm,
  type ReceiptEmailTemplate,
  receiptEmailContentKey,
  receiptEmailTemplateSourceSchema,
  type SupacrmForm,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useRef, useState } from "react"
import type { z } from "zod"
import { useWorkspaceId } from "@/hooks/routing"
import { client } from "@/lib/orpc/orpc"
import type { ReceiptEmailTemplateDraftResult } from "./template-draft"
import { useReceiptEmailTemplateDraft } from "./template-draft-context"

type Candidate = z.infer<typeof receiptEmailTemplateCandidateSchema>
type Usage = z.infer<typeof receiptEmailTemplateUsageSchema>
const key = (source: {
  flowId: string
  flowVersionId: string
  nodeId: string
}) => `${source.flowId}:${source.flowVersionId}:${source.nodeId}`

export function ReceiptEmailTemplateEditor({
  nodeId,
  settings,
  binding,
  onApplied,
}: {
  nodeId: string
  settings: SupacrmForm
  binding: ReceiptEmailTemplate | undefined
  onApplied: (
    node: Extract<ReceiptEmailTemplateDraftResult, { status: "ready" }>["node"],
  ) => void
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { run } = useReceiptEmailTemplateDraft()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selection, setSelection] = useState("")
  const [prompt, setPrompt] = useState(
    binding?.overrides.prompt ?? settings.prompt,
  )
  const [override, setOverride] = useState(
    binding ? binding.overrides.prompt !== undefined : true,
  )
  const [preview, setPreview] = useState<Extract<
    ReceiptEmailTemplateDraftResult,
    { status: "ready" }
  > | null>(null)
  const [usages, setUsages] = useState<Usage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const promptEditedRef = useRef(false)
  const bindingKey = receiptEmailContentKey(binding)
  const previousBindingKeyRef = useRef(bindingKey)
  useEffect(() => {
    const changedBinding = previousBindingKeyRef.current !== bindingKey
    previousBindingKeyRef.current = bindingKey
    if (changedBinding) {
      promptEditedRef.current = false
      setOverride(binding ? binding.overrides.prompt !== undefined : true)
      setPrompt(binding?.overrides.prompt ?? settings.prompt)
      setPreview(null)
    } else if (!(binding || promptEditedRef.current)) {
      setPrompt(settings.prompt)
      setPreview(null)
    }
  }, [binding, bindingKey, settings.prompt])
  const load = useCallback(async () => {
    if (!(workspaceId && run)) {
      return
    }
    setError(false)
    try {
      const result =
        await client.flowsAPI.privateReceiptEmailTemplateCandidates({
          workspaceId,
        })
      setCandidates(result.data)
      if (binding) {
        const latest = result.data.find(
          (item) =>
            item.isLatest &&
            item.flowId === binding.source.flowId &&
            item.nodeId === binding.source.nodeId,
        )
        setSelection(latest ? key(latest) : key(binding.source))
        setUnavailable(
          !result.data.some((item) => key(item) === key(binding.source)),
        )
      }
      setLoaded(true)
    } catch {
      setError(true)
    }
  }, [workspaceId, binding, run])
  // Inspector lookup only: runtime and ordinary rendering never resolve the pin.
  useEffect(() => {
    load()
  }, [load])
  const selected = candidates.find((item) => key(item) === selection)
  const accepted =
    binding && candidates.find((item) => key(item) === key(binding.source))
  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setUsages([])
      return
    }
    client.flowsAPI
      .privateReceiptEmailTemplateUsages({
        workspaceId,
        flowId: selected.flowId,
        nodeId: selected.nodeId,
      })
      .then(
        (result) => {
          if (!cancelled) {
            setUsages(result.data)
          }
        },
        () => {
          if (!cancelled) {
            setError(true)
          }
        },
      )
    return () => {
      cancelled = true
    }
  }, [workspaceId, selected])
  const describe = (item: Candidate) =>
    `${item.flowName} · ${item.label} · v${item.versionNumber} · ${new Date(item.publishedAt).toLocaleDateString()}`
  const change = async (action: "preview" | "adopt" | "detach") => {
    if (!run || (action !== "detach" && !selected)) {
      return
    }
    setBusy(true)
    setError(false)
    try {
      const target =
        action === "adopt"
          ? preview?.node.data.details.supacrmFormTemplate?.source
          : selected &&
            receiptEmailTemplateSourceSchema.parse({
              kind: selected.kind,
              flowId: selected.flowId,
              flowVersionId: selected.flowVersionId,
              nodeId: selected.nodeId,
            })
      if (action === "adopt" && !target) {
        return
      }
      const result = await run({
        nodeId,
        action,
        ...(action === "detach"
          ? {}
          : { source: target, overrides: override ? { prompt } : {} }),
      })
      if (result.status === "unavailable") {
        setUnavailable(true)
        setPreview(null)
        return
      }
      if (action === "preview") {
        setPreview(result)
      } else {
        onApplied(result.node)
        setPreview(null)
      }
    } catch {
      setError(true)
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label={t("supacrmTemplate.title")}
      className="space-y-3 rounded-md border p-3"
    >
      <h3 className="font-medium">{t("supacrmTemplate.title")}</h3>
      {binding && (
        <p title={key(binding.source)}>
          {t("supacrmTemplate.accepted")}:{" "}
          {accepted
            ? `${describe(accepted)} · ${t("supacrmTemplate.published")}`
            : t("supacrmTemplate.unavailable")}
        </p>
      )}
      {unavailable && <p role="status">{t("supacrmTemplate.unavailable")}</p>}
      <label className="block text-sm">
        {t("supacrmTemplate.source")}
        <select
          className="mt-1 w-full rounded border p-2"
          disabled={busy}
          onChange={(event) => {
            setSelection(event.target.value)
            setPreview(null)
            setUnavailable(false)
          }}
          value={selection}
        >
          <option value="">{t("supacrmTemplate.choose")}</option>
          {candidates.map((item) => (
            <option key={key(item)} value={key(item)}>
              {describe(item)} ·{" "}
              {t(
                item.isLatest
                  ? "supacrmTemplate.current"
                  : "supacrmTemplate.published",
              )}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <a
          className="block text-sm underline"
          href={`/space/${workspaceId}/flows/${selected.flowId}`}
        >
          {t("supacrmTemplate.editSource")}
        </a>
      )}
      <label className="flex gap-2 text-sm">
        <input
          checked={override}
          disabled={busy}
          onChange={(event) => {
            setOverride(event.target.checked)
            promptEditedRef.current = true
            setPreview(null)
          }}
          type="checkbox"
        />
        {t("supacrmTemplate.keepPrompt")}
      </label>
      {override && (
        <label className="block text-sm">
          {t("supacrmTemplate.promptOverride")}
          <textarea
            className="mt-1 min-h-16 w-full rounded border p-2"
            disabled={busy}
            maxLength={500}
            onChange={(event) => {
              setPrompt(event.target.value)
              promptEditedRef.current = true
              setPreview(null)
            }}
            value={prompt}
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            setPreview(null)
            load()
          }}
          type="button"
          variant="outline"
        >
          {t("supacrmTemplate.refresh")}
        </Button>
        <Button
          disabled={
            !run ||
            busy ||
            !selected ||
            unavailable ||
            (override && !prompt.trim())
          }
          onClick={() => change("preview")}
          type="button"
        >
          {t("supacrmTemplate.preview")}
        </Button>
        {binding && (
          <Button
            disabled={!run || busy}
            onClick={() => change("detach")}
            type="button"
            variant="outline"
          >
            {t("supacrmTemplate.detach")}
          </Button>
        )}
      </div>
      {preview && (
        <div className="space-y-2 rounded bg-muted p-2" role="status">
          <p>
            {t("supacrmTemplate.target")}: {selected && describe(selected)}
          </p>
          {override && (
            <p>
              {t("supacrmTemplate.promptRetained")}:{" "}
              {getSupacrmForm(preview.node.data.details)?.prompt}
            </p>
          )}
          {preview.changes.length === 0 && (
            <p>{t("supacrmTemplate.noChanges")}</p>
          )}
          {preview.changes.map((item) => (
            <p key={item.field}>
              <strong>{t(`supacrmForm.${item.field}`)}</strong>:{" "}
              {String(item.before)} → {String(item.after)}
            </p>
          ))}
          <Button disabled={busy} onClick={() => change("adopt")} type="button">
            {t("supacrmTemplate.adopt")}
          </Button>
        </div>
      )}
      {error && <p role="alert">{t("supacrmTemplate.error")}</p>}
      {loaded && candidates.length === 0 && <p>{t("supacrmTemplate.empty")}</p>}
      <h4 className="font-medium text-sm">{t("supacrmTemplate.usages")}</h4>
      {usages.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("supacrmTemplate.none")}
        </p>
      )}
      {usages.map((item) => {
        const revision = candidates.find(
          (candidate) =>
            candidate.flowId === selected?.flowId &&
            candidate.nodeId === selected?.nodeId &&
            candidate.flowVersionId === item.acceptedVersionId,
        )
        return (
          <a
            className="block text-sm underline"
            href={`/space/${workspaceId}/flows/${item.consumerFlowId}`}
            key={`${item.consumerVersionId}:${item.nodeId}`}
            title={`${item.consumerVersionId}:${item.nodeId}`}
          >
            {item.flowName} · {item.nodeLabel} ·{" "}
            {t(
              item.isDraft
                ? "supacrmTemplate.draft"
                : "supacrmTemplate.published",
            )}{" "}
            · {t("supacrmTemplate.accepted")}:{" "}
            {revision ? describe(revision) : t("supacrmTemplate.unavailable")}
          </a>
        )
      })}
    </section>
  )
}
