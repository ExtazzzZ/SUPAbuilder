"use client"

import "@xyflow/react/dist/style.css"
import type { Edge, Node } from "@xyflow/react"
import { useCallback, useState } from "react"
import type { FlowVersionResource } from "@/features/flow-versions/schema/resource"
import type { FlowResource } from "../schema/resource"
import { ReceiptEmailTemplateDraftProvider } from "../supacrm-form/template-draft-context"
import {
  NativeSourceFlowFrame,
  type NativeSourceFlowFrameProps,
} from "../supacrm-source/native/source-frame"
import { ButtonEditorDialog } from "./button-editor-dialog"
import { FrameHeader } from "./frame-header"
import { NodeDetailSheet } from "./nodes/node-detail-sheet"
import { ReactFlowWrapper } from "./react-flow-wrapper"
import { FlowHistoryStoreProvider } from "./stores/flow-history-store-provider"
import { useStepStore } from "./stores/step-store-provider"

type ReactFlowFrameProps = {
  flow: FlowResource
  flowVersion: FlowVersionResource
  canRevertToPublished: boolean
  hasPublishedVersion: boolean
}

export function ReactFlowFrame(
  props: ReactFlowFrameProps | NativeSourceFlowFrameProps,
) {
  if ("sourceBinding" in props) {
    const binding = props.sourceBinding
    const sourceScope = JSON.stringify([
      binding.bindingId,
      binding.workspaceId,
      binding.flowId,
      binding.registryId,
      binding.bindingVersion,
      [...binding.capabilities].sort(),
    ])
    return <NativeSourceFrameBoundary key={sourceScope} {...props} />
  }
  return <LegacyReactFlowFrame {...props} />
}

/** Семантическая привязка меняет mount; клонирование тех же props сохраняет локальный черновик. */
function NativeSourceFrameBoundary(props: NativeSourceFlowFrameProps) {
  const [sourceBinding] = useState(() =>
    Object.freeze({
      ...props.sourceBinding,
      capabilities: Object.freeze([...props.sourceBinding.capabilities]),
    }),
  )
  return <NativeSourceFlowFrame {...props} sourceBinding={sourceBinding} />
}

function LegacyReactFlowFrame({
  flow,
  flowVersion,
  canRevertToPublished,
  hasPublishedVersion,
}: ReactFlowFrameProps) {
  const openNodeDetailSheet = useStepStore((state) => state.openNodeDetailSheet)
  const setOpenNodeDetailSheet = useStepStore(
    (state) => state.setOpenNodeDetailSheet,
  )
  const [flushAutosave, setFlushAutosave] = useState<(() => void) | null>(null)
  const [cancelAutosave, setCancelAutosave] = useState<(() => void) | null>(
    null,
  )
  const [draftDirtied, setDraftDirtied] = useState(false)
  const [markSaved, setMarkSaved] = useState<
    ((nodes: Node[], edges: Edge[]) => void) | null
  >(null)

  const handleAutosaveFlushChange = useCallback(
    (flush: (() => void) | null) => {
      setFlushAutosave(() => flush)
    },
    [],
  )

  const handleAutosaveCancelChange = useCallback(
    (cancel: (() => void) | null) => {
      setCancelAutosave(() => cancel)
    },
    [],
  )

  const handleMarkSavedChange = useCallback(
    (nextMarkSaved: ((nodes: Node[], edges: Edge[]) => void) | null) => {
      setMarkSaved(() => nextMarkSaved)
    },
    [],
  )

  const handleDraftDirtiedChange = useCallback((dirtied: boolean) => {
    setDraftDirtied(dirtied)
  }, [])

  const handleNodeDetailSheetOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        flushAutosave?.()
      }

      setOpenNodeDetailSheet(open)
    },
    [flushAutosave, setOpenNodeDetailSheet],
  )

  return (
    <FlowHistoryStoreProvider key={flowVersion.id}>
      <ReceiptEmailTemplateDraftProvider>
        <FrameHeader
          cancelAutosave={cancelAutosave}
          canRevertToPublished={
            (canRevertToPublished || draftDirtied) && hasPublishedVersion
          }
          flow={flow}
          hasPublishedVersion={hasPublishedVersion}
          markSaved={markSaved}
        />

        <ReactFlowWrapper
          flowVersion={flowVersion}
          onAutosaveCancelChange={handleAutosaveCancelChange}
          onAutosaveFlushChange={handleAutosaveFlushChange}
          onDraftDirtiedChange={handleDraftDirtiedChange}
          onMarkSavedChange={handleMarkSavedChange}
          setOpenNodeDetailSheet={setOpenNodeDetailSheet}
        />

        <NodeDetailSheet
          onOpenChange={handleNodeDetailSheetOpenChange}
          open={openNodeDetailSheet}
        />

        <ButtonEditorDialog />
      </ReceiptEmailTemplateDraftProvider>
    </FlowHistoryStoreProvider>
  )
}
