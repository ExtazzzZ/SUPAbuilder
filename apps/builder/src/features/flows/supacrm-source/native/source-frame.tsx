"use client"

import {
  type SourceAuthoringEnvelopeV1,
  sourceAuthoringEnvelopeV1Schema,
} from "@chatbotx.io/flow-config"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { NativeSourceBinding } from "@/lib/source-authoring-native/authorization"
import { FrameHeader } from "../../react-flow/frame-header"
import { NodeDetailSheet } from "../../react-flow/nodes/node-detail-sheet"
import { ReactFlowWrapper } from "../../react-flow/react-flow-wrapper"
import { useStepStore } from "../../react-flow/stores/step-store-provider"
import type { FlowResource } from "../../schema/resource"
import {
  type MessageFieldSurface,
  messageFieldSurfaceSchema,
} from "../message-authoring/message-field-surface"
import type { MessageAuthoringPort } from "../message-authoring/port"
import type { NativeSourceEditorPort } from "./document-port"
import {
  nativeSourceNodeId,
  nativeSourceScopeKey,
  toNativeSourceProjection,
} from "./projection-adapter"
import {
  NativeSourcePropertyProvider,
  type NativeSourcePropertyState,
} from "./property-context"
import type { NativeSourceProjection, SourceCanvasNodeData } from "./types"

export interface NativeSourceFlowFrameProps {
  flow: FlowResource
  sourceBinding: NativeSourceBinding
  sourcePort?: NativeSourceEditorPort | null
}
const identity = (value: SourceAuthoringEnvelopeV1) =>
  JSON.stringify([value.source_revision, value.draft_version])
const emptyGraph: NativeSourceProjection = {
  nodes: [],
  edges: [],
  unresolvedEdges: [],
  scopeKey: "unavailable",
}
/** Штатный native frame. Поле и canonical document живут вне legacy node.data/FlowVersion. */
export function NativeSourceFlowFrame({
  flow,
  sourceBinding: binding,
  sourcePort: port,
}: NativeSourceFlowFrameProps) {
  const t = useTranslations("supacrmNativeSource.frame")
  const labels = {
    blocked: t("blocked"),
    loading: t("loading"),
    unavailable: t("unavailable"),
    failed: t("failed"),
    draft: t("draft"),
    dirty: t("dirty"),
    unknown: t("unknown"),
    published: t("published"),
    validate: t("validate"),
    publish: t("publish"),
    reload: t("reload"),
    pending: t("pending"),
  }
  const open = useStepStore((s) => s.openNodeDetailSheet),
    setOpen = useStepStore((s) => s.setOpenNodeDetailSheet)
  const [envelope, setEnvelope] = useState<SourceAuthoringEnvelopeV1>()
  const envelopeRef = useRef<SourceAuthoringEnvelopeV1 | undefined>(undefined)
  const [selected, setSelected] = useState<{
    scenarioId: string
    sourceId: string
  }>()
  const [loading, setLoading] = useState(true),
    loadingRef = useRef(true)
  const [mutating, setMutating] = useState(false),
    pendingRef = useRef(false)
  const [dirty, setDirty] = useState(false),
    dirtyRef = useRef(false)
  const [unknown, setUnknown] = useState(false),
    unknownRef = useRef(false)
  const [error, setError] = useState(false)
  const [validated, setValidated] = useState<string>()
  const [surface, setSurface] = useState<MessageFieldSurface>()
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [surfaceError, setSurfaceError] = useState(false)
  const epoch = useRef(0),
    controller = useRef<AbortController | undefined>(undefined)

  const accept = useCallback(
    (value: SourceAuthoringEnvelopeV1) => {
      const next = sourceAuthoringEnvelopeV1Schema.parse(value)
      toNativeSourceProjection(binding, next)
      envelopeRef.current = next
      setEnvelope(next)
      dirtyRef.current = false
      setDirty(false)
      setValidated(undefined)
      setError(false)
    },
    [binding],
  )
  const reload = useCallback(async () => {
    if (pendingRef.current) {
      return
    }
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const current = ++epoch.current
    loadingRef.current = true
    setLoading(true)
    setError(false)
    envelopeRef.current = undefined
    setEnvelope(undefined)
    setSurface(undefined)
    setValidated(undefined)
    dirtyRef.current = false
    unknownRef.current = false
    setDirty(false)
    setUnknown(false)
    try {
      if (!port) {
        throw new Error("source_transport_unavailable")
      }
      const value = await port.load(abort.signal)
      if (current === epoch.current && !abort.signal.aborted) {
        accept(value)
      }
    } catch {
      if (current === epoch.current && !abort.signal.aborted) {
        setError(true)
      }
    } finally {
      if (current === epoch.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [port, accept])
  useEffect(() => {
    reload()
    return () => {
      epoch.current++
      controller.current?.abort()
    }
  }, [reload])

  const graph = useMemo(
    () => (envelope ? toNativeSourceProjection(binding, envelope) : emptyGraph),
    [binding, envelope],
  )
  const selectedNode = envelope?.projection.nodes.find(
    (n) =>
      n.scenarioId === selected?.scenarioId &&
      n.sourceId === selected?.sourceId,
  )
  const selectedNodeId = selected
    ? nativeSourceNodeId(binding, selected.scenarioId, selected.sourceId)
    : undefined
  const begin = useCallback(() => {
    if (
      loadingRef.current ||
      pendingRef.current ||
      unknownRef.current ||
      !envelopeRef.current
    ) {
      return false
    }
    pendingRef.current = true
    setMutating(true)
    setValidated(undefined)
    return true
  }, [])
  const end = useCallback(() => {
    pendingRef.current = false
    setMutating(false)
  }, [])
  const fieldDirty = useCallback((value: boolean) => {
    dirtyRef.current = value
    setDirty(value)
    if (value) {
      setValidated(undefined)
    }
  }, [])
  const fieldUnknown = useCallback((value: boolean) => {
    unknownRef.current = value
    setUnknown(value)
    if (value) {
      setValidated(undefined)
    }
  }, [])
  const select = useCallback(
    (data: SourceCanvasNodeData) => {
      const current = envelopeRef.current
      if (
        loadingRef.current ||
        pendingRef.current ||
        dirtyRef.current ||
        unknownRef.current ||
        !current ||
        data.bindingId !== binding.bindingId ||
        data.registryId !== binding.registryId ||
        data.scopeKey !== nativeSourceScopeKey(binding, current)
      ) {
        return
      }
      if (
        !current.projection.nodes.some(
          (n) =>
            n.scenarioId === data.scenarioId && n.sourceId === data.sourceId,
        )
      ) {
        return
      }
      setSelected({ scenarioId: data.scenarioId, sourceId: data.sourceId })
      setOpen(true)
    },
    [binding, setOpen],
  )
  const changeOpen = useCallback(
    (value: boolean) => {
      if (
        pendingRef.current ||
        dirtyRef.current ||
        unknownRef.current ||
        loadingRef.current
      ) {
        return
      }
      setOpen(value)
    },
    [setOpen],
  )

  useEffect(() => {
    setSurface(undefined)
    setSurfaceError(false)
    if (
      !(port && envelope?.source_hash) ||
      selectedNode?.kind !== "send_message"
    ) {
      setSurfaceLoading(false)
      return
    }
    const abort = new AbortController()
    setSurfaceLoading(true)
    port
      .messageFields(abort.signal)
      .then((input) => {
        if (abort.signal.aborted) {
          return
        }
        const value = messageFieldSurfaceSchema.parse(input)
        if (
          value.source_revision !== envelope.source_revision ||
          value.source_hash !== envelope.source_hash ||
          value.draft_version !== envelope.draft_version
        ) {
          throw new Error("source_surface_scope")
        }
        setSurface(value)
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setSurfaceError(true)
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setSurfaceLoading(false)
        }
      })
    return () => abort.abort()
  }, [
    port,
    envelope?.source_revision,
    envelope?.source_hash,
    envelope?.draft_version,
    selectedNode?.kind,
  ])
  const field = surface?.fields.find(
    (f) =>
      f.target.scenario_id === selectedNode?.scenarioId &&
      f.target.block_id === selectedNode?.sourceId &&
      f.target.path === "params.markup",
  )
  const messageEditor = useMemo<
    NativeSourcePropertyState["messageEditor"]
  >(() => {
    if (
      !(port && envelope?.source_hash && field?.editable) ||
      selectedNode?.kind !== "send_message" ||
      field.handler_id !== "source-presentation/1" ||
      field.schema_ref !== "source.message.plain-text/1" ||
      !field.policy_revision ||
      !field.descriptor_version
    ) {
      return
    }
    const base = envelope,
      sourceHash = envelope.source_hash
    let compiled: SourceAuthoringEnvelopeV1 | undefined
    const messagePort: MessageAuthoringPort = {
      readField: async (fieldId, pin) => {
        if (
          fieldId !== field.field_id ||
          pin.sourceRevision !== base.source_revision ||
          pin.sourceHash !== sourceHash ||
          pin.draftVersion !== base.draft_version
        ) {
          throw new Error("source_field_scope")
        }
        const view = await port.messageView(
          {
            schema_version: "message-field-view-request/1",
            field_id: fieldId,
            expected_full_ir_id: pin.sourceRevision,
            expected_draft_version: pin.draftVersion,
          },
          pin.sourceHash,
        )
        return { field, view }
      },
      writeLiteral: (write) => port.messageSlot(write),
      compileField: async (edit) => {
        compiled = sourceAuthoringEnvelopeV1Schema.parse(
          await port.messageCompile(edit),
        )
        return {
          sourceRevision: compiled.source_revision,
          sourceHash: compiled.source_hash ?? "",
          draftVersion: compiled.draft_version,
        }
      },
    }
    return {
      scope: {
        fieldId: field.field_id,
        sourceKind: selectedNode.kind,
        target: field.target,
        fullPin: {
          sourceRevision: base.source_revision,
          sourceHash,
          draftVersion: base.draft_version,
        },
      },
      port: messagePort,
      onCompiled: () => {
        if (compiled) {
          accept(compiled)
        }
      },
      onDirtyChange: fieldDirty,
      onUnknownChange: fieldUnknown,
      onMutationStart: begin,
      onMutationEnd: end,
      onReloadRequested: reload,
    }
  }, [
    port,
    envelope,
    field,
    selectedNode?.kind,
    accept,
    fieldDirty,
    fieldUnknown,
    begin,
    end,
    reload,
  ])
  let propertyStatus: NativeSourcePropertyState["status"] = "readonly"
  if (messageEditor) {
    propertyStatus = "ready"
  }
  if (surfaceError) {
    propertyStatus = "error"
  }
  if (loading || surfaceLoading) {
    propertyStatus = "loading"
  }
  const property: NativeSourcePropertyState = {
    binding,
    envelope,
    status: propertyStatus,
    messageEditor,
    diagnosticCode: field?.code,
  }
  const locked = loading || mutating || dirty || unknown || error
  const run = async (action: "validate" | "publish") => {
    const base = envelopeRef.current
    if (
      !(port && base) ||
      dirtyRef.current ||
      unknownRef.current ||
      pendingRef.current ||
      loadingRef.current ||
      error ||
      (action === "publish" &&
        (!base.publishable || validated !== identity(base)))
    ) {
      return
    }
    const version = epoch.current
    if (!begin()) {
      return
    }
    try {
      const next = sourceAuthoringEnvelopeV1Schema.parse(
        await port[action](base),
      )
      if (version !== epoch.current) {
        return
      }
      if (
        next.source_revision !== base.source_revision ||
        next.draft_version !== base.draft_version
      ) {
        throw new Error("source_response_scope")
      }
      accept(next)
      setValidated(identity(next))
    } catch {
      if (version === epoch.current) {
        unknownRef.current = true
        setUnknown(true)
        setValidated(undefined)
      }
    } finally {
      end()
    }
  }
  let documentLabel = labels.draft
  if (envelope && envelope.published_revision === envelope.source_revision) {
    documentLabel = labels.published
  }
  if (dirty) {
    documentLabel = labels.dirty
  }
  if (unknown) {
    documentLabel = labels.unknown
  }
  const actions = (
    <div className="flex items-center gap-2">
      <Badge variant="secondary">{documentLabel}</Badge>
      <Button
        data-source-action="validate"
        disabled={!envelope || locked}
        onClick={() => run("validate")}
        type="button"
        variant="outline"
      >
        {mutating ? labels.pending : labels.validate}
      </Button>
      <Button
        data-source-action="publish"
        disabled={
          !envelope?.publishable ||
          locked ||
          !envelope ||
          validated !== identity(envelope)
        }
        onClick={() => run("publish")}
        type="button"
      >
        {labels.publish}
      </Button>
      <Button
        data-source-action="reload"
        disabled={loading || mutating}
        onClick={reload}
        type="button"
        variant="outline"
      >
        {labels.reload}
      </Button>
    </div>
  )
  return (
    <NativeSourcePropertyProvider value={property}>
      <FrameHeader
        cancelAutosave={null}
        canRevertToPublished={false}
        flow={flow}
        hasPublishedVersion={Boolean(envelope?.published_revision)}
        markSaved={null}
        sourceActions={actions}
      />
      {loading && (
        <p className="px-4 py-2 text-muted-foreground" role="status">
          {labels.loading}
        </p>
      )}
      {(error || unknown) && (
        <p className="px-4 py-2 text-destructive" role="alert">
          {error ? labels.unavailable : labels.failed}
        </p>
      )}
      {envelope && !envelope.publishable && envelope.diagnostics.length > 0 && (
        <div className="px-4 py-2 text-destructive" role="alert">
          <p>{labels.blocked}</p>
          <ul>
            {envelope.diagnostics.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Public diagnostics have no unique id or local state.
              <li key={`${item.code}-${item.block_id ?? ""}-${index}`}>
                {item.code}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <ReactFlowWrapper
          onSourcePane={() => changeOpen(false)}
          onSourceSelect={select}
          selectedNodeId={selectedNodeId}
          sourceDocument={graph}
          sourceLocked={locked}
        />
      </div>
      <NodeDetailSheet onOpenChange={changeOpen} open={open} />
    </NativeSourcePropertyProvider>
  )
}
