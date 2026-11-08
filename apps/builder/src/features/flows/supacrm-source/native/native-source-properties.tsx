"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import {
  MessageFieldController,
  type MessageFieldControllerProps,
} from "../message-authoring/message-field-controller"
import { NativeMessageFieldForm } from "./native-message-field-form"
import { nativeSourceScopeKey } from "./projection-adapter"
import { useNativeSourceProperty } from "./property-context"
import {
  useNativeSourceMessageLabels,
  useNativeSourcePropertyLabels,
} from "./property-labels"
import type { SourceCanvasNode } from "./types"

const renderNativeReload: NonNullable<
  MessageFieldControllerProps["renderReload"]
> = ({ label, disabled, onClick }) => (
  <Button
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    type="button"
    variant="outline"
  >
    {label}
  </Button>
)

/** Source-ветка штатной панели; отсутствие подтверждения никогда не включает legacy editor. */
export function NativeSourceProperties({
  node,
  open,
  onOpenChange,
}: {
  node?: SourceCanvasNode
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const state = useNativeSourceProperty()
  const labels = useNativeSourcePropertyLabels()
  const messageLabels = useNativeSourceMessageLabels()
  const data = node?.data
  const envelope = state?.envelope
  const bound = Boolean(
    data &&
      state &&
      envelope?.source_hash &&
      state.binding.bindingId === data.bindingId &&
      state.binding.registryId === data.registryId &&
      nativeSourceScopeKey(state.binding, envelope) === data.scopeKey,
  )
  const source =
    bound && data
      ? envelope?.projection.nodes.find(
          (item) =>
            item.sourceId === data.sourceId &&
            item.scenarioId === data.scenarioId &&
            item.kind === data.sourceKind,
        )
      : undefined
  const editor = state?.messageEditor
  const scope = editor?.scope
  const canEdit = Boolean(
    bound &&
      state?.status === "ready" &&
      source?.kind === "send_message" &&
      scope &&
      scope.sourceKind === source.kind &&
      scope.target.scenario_id === data?.scenarioId &&
      scope.target.block_id === data?.sourceId &&
      scope.target.path === "params.markup" &&
      scope.fullPin.sourceRevision === envelope?.source_revision &&
      scope.fullPin.sourceHash === envelope?.source_hash &&
      scope.fullPin.draftVersion === envelope?.draft_version,
  )
  let statusLabel = labels.readonly
  if (state?.status === "loading") {
    statusLabel = labels.loading
  }
  if (state?.status === "error") {
    statusLabel = labels.error
  }
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex flex-col gap-0" side="left">
        <SheetTitle className="px-5 py-3 text-lg">
          {data?.label ?? labels.readonly}
        </SheetTitle>
        <SheetDescription className="px-5">
          {labels.description}
        </SheetDescription>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <Card>
            <CardContent className="p-4">
              {canEdit && editor ? (
                <MessageFieldController
                  {...editor}
                  formComponent={NativeMessageFieldForm}
                  key={data?.scopeKey}
                  label={messageLabels.title}
                  labels={messageLabels}
                  renderReload={renderNativeReload}
                />
              ) : (
                <p role={state?.status === "error" ? "alert" : "status"}>
                  {statusLabel}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </SheetContent>
    </Sheet>
  )
}
