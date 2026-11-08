"use client"

import type {
  SourceAuthoringEnvelopeV1,
  SourceNode,
} from "@chatbotx.io/flow-config"
import { useLocale } from "next-intl"
import { useEffect, useMemo, useRef, useState } from "react"
import { messageAuthoringLabels } from "./labels"
import { MessageFieldController } from "./message-field-controller"
import type { MessageFieldHttpClient } from "./message-field-http"
import type { MessageFieldSurface } from "./message-field-surface"
import type { MessageAuthoringPort } from "./port"

export interface MessageAuthoringPanelProps {
  botId: string
  client: MessageFieldHttpClient
  envelope: SourceAuthoringEnvelopeV1
  node: SourceNode
  onCompiled: (envelope: SourceAuthoringEnvelopeV1) => void
  onDirtyChange: (dirty: boolean) => void
  onMutationEnd: () => void
  onMutationStart: () => boolean
  onReloadRequested: () => Promise<void>
  onUnknownChange: (unknown: boolean) => void
}

/** Surface не содержит текста; разрешённый текст читается отдельным scoped POST. */
export function MessageAuthoringPanel(props: MessageAuthoringPanelProps) {
  const { client, botId, envelope, node } = props
  const labels = messageAuthoringLabels(useLocale())
  const [surface, setSurface] = useState<MessageFieldSurface>()
  const [failed, setFailed] = useState(false)
  const compiled = useRef<SourceAuthoringEnvelopeV1 | undefined>(undefined)
  useEffect(() => {
    const abort = new AbortController()
    setSurface(undefined)
    setFailed(false)
    if (node.kind !== "send_message") {
      return () => abort.abort()
    }
    client
      .surface(botId, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) {
          return
        }
        if (
          value.source_revision !== envelope.source_revision ||
          value.source_hash !== envelope.source_hash ||
          value.draft_version !== envelope.draft_version
        ) {
          setFailed(true)
          return
        }
        setSurface(value)
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setFailed(true)
        }
      })
    return () => abort.abort()
  }, [
    client,
    botId,
    node.kind,
    envelope.source_revision,
    envelope.source_hash,
    envelope.draft_version,
  ])
  const field = surface?.fields.find(
    (item) =>
      item.target.block_id === node.sourceId &&
      item.target.scenario_id === node.scenarioId &&
      item.target.path === "params.markup",
  )
  const port = useMemo<MessageAuthoringPort>(
    () => ({
      readField: async (fieldId, pin) => {
        if (!field || field.field_id !== fieldId) {
          throw new Error("field_scope_mismatch")
        }
        if (
          !field.editable ||
          field.handler_id !== "source-presentation/1" ||
          field.schema_ref !== "source.message.plain-text/1" ||
          !field.policy_revision ||
          !field.descriptor_version
        ) {
          return { field }
        }
        const view = await client.view(
          botId,
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
      writeLiteral: (write) => client.slot(botId, write),
      compileField: async (edit) => {
        const next = await client.compile(botId, edit)
        compiled.current = next
        return {
          sourceRevision: next.source_revision,
          sourceHash: next.source_hash ?? "",
          draftVersion: next.draft_version,
        }
      },
    }),
    [client, botId, field],
  )
  if (node.kind !== "send_message") {
    return null
  }
  if (failed) {
    return <p role="alert">{labels.unavailable}</p>
  }
  if (!surface) {
    return <p role="status">{labels.loading}</p>
  }
  if (!(field && envelope.source_hash)) {
    return <p>{labels.readOnly}</p>
  }
  return (
    <MessageFieldController
      label={labels.title}
      labels={labels}
      onCompiled={() => {
        if (compiled.current) {
          props.onCompiled(compiled.current)
        }
      }}
      onDirtyChange={props.onDirtyChange}
      onMutationEnd={props.onMutationEnd}
      onMutationStart={props.onMutationStart}
      onReloadRequested={props.onReloadRequested}
      onUnknownChange={props.onUnknownChange}
      port={port}
      scope={{
        fieldId: field.field_id,
        target: field.target,
        sourceKind: node.kind,
        fullPin: {
          sourceRevision: envelope.source_revision,
          sourceHash: envelope.source_hash,
          draftVersion: envelope.draft_version,
        },
      }}
    />
  )
}
