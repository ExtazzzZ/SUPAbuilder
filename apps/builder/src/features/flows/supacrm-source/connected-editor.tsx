"use client"

import type {
  SourceAuthoringEnvelopeV1,
  SourceLogicalEditV1,
  SourceLogicProjectionV1,
  SourceProjection,
} from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { SourceLogicEditor } from "./logic-editor"
import { MessageAuthoringPanel } from "./message-authoring/message-authoring-panel"
import type { MessageFieldHttpClient } from "./message-authoring/message-field-http"
import { SourceAuthoringClient, SourceAuthoringError } from "./source-client"
import { SupacrmSourceEditor } from "./source-editor"
import { SupacrmSourceGraph } from "./source-graph"

const editIdentity = (edit: SourceLogicalEditV1) =>
  JSON.stringify([edit.kind, edit.target])
const validationIdentity = (value: SourceAuthoringEnvelopeV1) =>
  JSON.stringify([value.source_revision, value.draft_version])

/** Единый authoring: draft → canonical compile → server validation → публикация версии. */
export function ConnectedSupacrmSourceEditor({
  botId,
  client: providedClient,
  messageClient,
}: {
  botId: string
  client?: SourceAuthoringClient
  messageClient?: MessageFieldHttpClient
}) {
  const t = useTranslations("supacrmSource")
  const client = useMemo(
    () => providedClient ?? new SourceAuthoringClient(),
    [providedClient],
  )
  const [envelope, setEnvelope] = useState<SourceAuthoringEnvelopeV1>()
  const [projection, setProjection] = useState<SourceProjection>()
  const [logic, setLogic] = useState<SourceLogicProjectionV1>()
  const [logicDirty, setLogicDirty] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [published, setPublished] = useState(false)
  const [validated, setValidated] = useState<string>()
  const [error, setError] = useState<SourceAuthoringError["code"]>()
  const [rejectedDiagnostics, setRejectedDiagnostics] = useState<
    SourceAuthoringError["diagnostics"]
  >([])
  const [reload, setReload] = useState(0)
  const [messageDirty, setMessageDirty] = useState(false)
  const [messageUnknown, setMessageUnknown] = useState(false)
  const messageUnknownRef = useRef(false)
  const messageDirtyRef = useRef(false)
  const writePending = useRef(false)
  const epoch = useRef(0)
  const blocked =
    error === "conflict" || error === "save_unconfirmed" || messageUnknown

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload — явная сверка пользователя с сервером.
  useEffect(() => {
    const controller = new AbortController()
    const current = ++epoch.current
    let active = true
    setLoading(true)
    setSaved(false)
    setPublished(false)
    setError(undefined)
    setEnvelope(undefined)
    setProjection(undefined)
    setLogic(undefined)
    setDirty(false)
    setLogicDirty(false)
    setValidated(undefined)
    setRejectedDiagnostics([])
    setMessageDirty(false)
    setMessageUnknown(false)
    messageUnknownRef.current = false
    messageDirtyRef.current = false
    client
      .load(botId, controller.signal)
      .then((value) => {
        if (active && epoch.current === current) {
          setEnvelope(value)
          setProjection(value.projection)
          setLogic(value.logic)
          setSelectedSourceId(value.projection.nodes[0]?.sourceId ?? "")
        }
      })
      .catch((cause) => {
        if (active && !controller.signal.aborted) {
          setError(
            cause instanceof SourceAuthoringError ? cause.code : "unavailable",
          )
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
      epoch.current++
      controller.abort()
    }
  }, [botId, client, reload])

  const run = async (action: "save" | "compile" | "validate" | "publish") => {
    if (
      !(envelope && projection) ||
      loading ||
      writePending.current ||
      blocked ||
      messageUnknownRef.current ||
      messageDirtyRef.current
    ) {
      return
    }
    if (action === "save" && !dirty) {
      return
    }
    if (action === "compile" && (!(logic && logicDirty) || dirty)) {
      return
    }
    if (
      (action === "validate" || action === "publish") &&
      (dirty || logicDirty)
    ) {
      return
    }
    if (
      action === "publish" &&
      (!envelope.publishable || validated !== validationIdentity(envelope))
    ) {
      return
    }
    writePending.current = true
    setSaving(true)
    setError(undefined)
    setRejectedDiagnostics([])
    setSaved(false)
    setPublished(false)
    const current = epoch.current
    try {
      let next: SourceAuthoringEnvelopeV1
      if (action === "save") {
        next = await client.save(botId, envelope, projection)
      } else if (action === "compile" && logic) {
        next = await client.compile(botId, envelope, logic)
      } else if (action === "publish") {
        next = await client.publish(botId, envelope)
      } else {
        next = await client.validate(botId, envelope)
      }
      if (current !== epoch.current) {
        return
      }
      setEnvelope(next)
      setProjection(next.projection)
      setDirty(false)
      // Сохранение layout/message draft не стирает ещё не скомпилированную правку логики.
      if (action !== "save" || !logicDirty) {
        setLogic(next.logic)
        setLogicDirty(false)
      }
      setSaved(action === "save")
      setPublished(action === "publish")
      setValidated(
        action === "validate" || action === "publish"
          ? validationIdentity(next)
          : undefined,
      )
    } catch (cause) {
      if (current === epoch.current) {
        setValidated(undefined)
        setError(
          cause instanceof SourceAuthoringError
            ? cause.code
            : "save_unconfirmed",
        )
        if (cause instanceof SourceAuthoringError) {
          setRejectedDiagnostics(cause.diagnostics)
        }
      }
    } finally {
      writePending.current = false
      setSaving(false)
    }
  }
  const changeProjection = (next: SourceProjection) => {
    setProjection(next)
    setDirty(true)
    setSaved(false)
    setPublished(false)
    setValidated(undefined)
  }
  const acceptMessage = useCallback((next: SourceAuthoringEnvelopeV1) => {
    setEnvelope(next)
    setProjection(next.projection)
    setLogic(next.logic)
    setDirty(false)
    setLogicDirty(false)
    setMessageDirty(false)
    messageDirtyRef.current = false
    setValidated(undefined)
    setPublished(false)
    setSaved(false)
    setError(undefined)
  }, [])
  const beginMessageMutation = () => {
    if (
      loading ||
      saving ||
      dirty ||
      logicDirty ||
      blocked ||
      messageUnknownRef.current ||
      writePending.current
    ) {
      return false
    }
    writePending.current = true
    setSaving(true)
    setValidated(undefined)
    return true
  }
  const reloadCanonical = useCallback(() => {
    setReload((value) => value + 1)
    return Promise.resolve()
  }, [])
  const messageDirtyChanged = useCallback((value: boolean) => {
    messageDirtyRef.current = value
    setMessageDirty(value)
    if (value) {
      setValidated(undefined)
    }
  }, [])
  const messageUnknownChanged = useCallback((value: boolean) => {
    messageUnknownRef.current = value
    setMessageUnknown(value)
  }, [])
  const endMessageMutation = useCallback(() => {
    writePending.current = false
    setSaving(false)
  }, [])
  const selectSource = (sourceId: string) => {
    if (
      loading ||
      saving ||
      blocked ||
      writePending.current ||
      messageDirtyRef.current ||
      messageUnknownRef.current
    ) {
      return
    }
    setSelectedSourceId(sourceId)
  }
  const selectedNode = projection?.nodes.find(
    (node) => node.sourceId === selectedSourceId,
  )
  const visibleLogic = logic
    ? {
        ...logic,
        edits: logic.edits.filter(
          (edit) => edit.target.block_id === selectedSourceId,
        ),
      }
    : undefined
  const changeLogic = (edited: SourceLogicProjectionV1) => {
    if (!logic) {
      return
    }
    const updates = new Map(
      edited.edits.map((edit) => [editIdentity(edit), edit]),
    )
    setLogic({
      ...logic,
      edits: logic.edits.map((edit) => updates.get(editIdentity(edit)) ?? edit),
    })
    setLogicDirty(true)
    setValidated(undefined)
    setPublished(false)
  }
  return (
    <section className="flex flex-col gap-4">
      {loading && <p role="status">{t("loading")}</p>}
      {error && <p role="alert">{t(`errors.${error}`)}</p>}
      {saved && <p role="status">{t("draftSaved")}</p>}
      {published && <p role="status">{t("versionPublished")}</p>}
      {envelope &&
        (!envelope.publishable || rejectedDiagnostics.length > 0) && (
          <div role="alert">
            <h2>{t("serverDiagnostics")}</h2>
            <ul>
              {[...envelope.diagnostics, ...rejectedDiagnostics].map(
                (item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Диагностики не имеют ID; строка не хранит состояние.
                  <li key={`${item.code}-${item.block_id ?? ""}-${index}`}>
                    {item.code} · {item.block_id}
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
      {projection && (
        <SupacrmSourceGraph
          disabled={loading || saving || messageDirty || blocked}
          key={projection.sourceRevision}
          onChange={changeProjection}
          onSelectSource={selectSource}
          projection={projection}
          selectedSourceId={selectedSourceId}
        />
      )}
      <fieldset
        className="border-0 p-0"
        disabled={loading || saving || messageDirty || blocked}
      >
        {projection && (
          <SupacrmSourceEditor
            key={projection.sourceRevision}
            onChange={changeProjection}
            onSelectSource={selectSource}
            projection={projection}
            selectedSourceId={selectedSourceId}
            showMessageDraft={
              !(messageClient && selectedNode?.kind === "send_message")
            }
            showPublish={false}
          />
        )}
        {projection && visibleLogic && (
          <SourceLogicEditor
            baseline={
              envelope?.logic
                ? {
                    ...envelope.logic,
                    edits: envelope.logic.edits.filter(
                      (edit) => edit.target.block_id === selectedSourceId,
                    ),
                  }
                : undefined
            }
            key={`${envelope?.source_revision}-${selectedSourceId}`}
            logic={visibleLogic}
            onChange={changeLogic}
            projection={projection}
          />
        )}
      </fieldset>
      {messageClient && envelope && selectedNode && (
        <fieldset
          className="border-0 p-0"
          disabled={
            dirty ||
            logicDirty ||
            loading ||
            saving ||
            error === "conflict" ||
            error === "save_unconfirmed"
          }
        >
          <MessageAuthoringPanel
            botId={botId}
            client={messageClient}
            envelope={envelope}
            key={`${envelope.source_revision}-${envelope.draft_version}-${selectedSourceId}`}
            node={selectedNode}
            onCompiled={acceptMessage}
            onDirtyChange={messageDirtyChanged}
            onMutationEnd={endMessageMutation}
            onMutationStart={beginMessageMutation}
            onReloadRequested={reloadCanonical}
            onUnknownChange={messageUnknownChanged}
          />
        </fieldset>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          data-action="save-draft"
          disabled={!dirty || loading || saving || blocked || messageDirty}
          onClick={() => run("save")}
          type="button"
        >
          {saving ? t("saving") : t("save")}
        </button>
        <button
          data-action="compile-source"
          disabled={
            !logicDirty || dirty || loading || saving || blocked || messageDirty
          }
          onClick={() => run("compile")}
          type="button"
        >
          {t("compileLogic")}
        </button>
        <button
          data-action="validate-source"
          disabled={
            !envelope ||
            dirty ||
            logicDirty ||
            loading ||
            saving ||
            blocked ||
            messageDirty
          }
          onClick={() => run("validate")}
          type="button"
        >
          {t("validateVersion")}
        </button>
        <button
          data-action="publish-source"
          disabled={
            !envelope?.publishable ||
            validated !== (envelope && validationIdentity(envelope)) ||
            dirty ||
            logicDirty ||
            loading ||
            saving ||
            blocked ||
            messageDirty
          }
          onClick={() => run("publish")}
          type="button"
        >
          {t("publishVersion")}
        </button>
        <button
          disabled={saving || loading}
          onClick={() => setReload((value) => value + 1)}
          type="button"
        >
          {t("reload")}
        </button>
      </div>
    </section>
  )
}
