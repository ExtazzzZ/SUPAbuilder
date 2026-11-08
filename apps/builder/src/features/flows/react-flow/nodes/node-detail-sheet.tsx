"use client"

import {
  type FlowNode,
  getSupacrmCheckout,
  getSupacrmDataRequest,
  getSupacrmForm,
  getSupacrmFulfillment,
  getSupacrmOperator,
  getSupacrmProduct,
  getSupacrmReminder,
  getSupacrmVariable,
  type NodeType,
  type SendMessageNodeSchema,
} from "@chatbotx.io/flow-config"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import { useReactFlow, useStore } from "@xyflow/react"
import { LoaderCircleIcon } from "lucide-react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useCustomFields } from "@/features/custom-fields/provider/custom-field-hook"
import { useWorkspaceId } from "@/hooks/routing"
import { SupacrmCheckoutEditor } from "../../supacrm-checkout/checkout-editor"
import { SupacrmDataRequestEditor } from "../../supacrm-data-request/data-request-editor"
import { SupacrmFormEditor } from "../../supacrm-form/form-editor"
import { SupacrmFulfillmentEditor } from "../../supacrm-fulfillment/fulfillment-editor"
import { SupacrmOperatorEditor } from "../../supacrm-operator/operator-editor"
import { SupacrmProductEditor } from "../../supacrm-product/product-editor"
import { SupacrmReminderEditor } from "../../supacrm-reminder/reminder-editor"
import { NativeSourceProperties } from "../../supacrm-source/native/native-source-properties"
import { isSourceCanvasNode } from "../../supacrm-source/native/projection-adapter"
import { useNativeSourceProperty } from "../../supacrm-source/native/property-context"
import { SupacrmVariableEditor } from "../../supacrm-variable/variable-editor"
import { NodeEditor } from "./editor"
import { NodeNameEditor } from "./node-name-editor"
import {
  hasSourceDocumentMode,
  selectedNodeEqualityFn,
  selectSelectedNode,
} from "./selected-node-equality"

type NodeDetailSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NodeDetailSheet({ open, onOpenChange }: NodeDetailSheetProps) {
  const activeNode = useStore(selectSelectedNode, selectedNodeEqualityFn)
  const sourceContext = useNativeSourceProperty()
  if (sourceContext !== null || hasSourceDocumentMode(activeNode)) {
    if (!activeNode) {
      return null
    }
    return open ? (
      <NativeSourceProperties
        node={isSourceCanvasNode(activeNode) ? activeNode : undefined}
        onOpenChange={onOpenChange}
        open={open}
      />
    ) : null
  }
  return (
    <LegacyNodeDetailSheet
      activeNode={isSourceCanvasNode(activeNode) ? null : activeNode}
      onOpenChange={onOpenChange}
      open={open}
    />
  )
}

function LegacyNodeDetailSheet({
  activeNode,
  open,
  onOpenChange,
}: NodeDetailSheetProps & { activeNode: FlowNode | null }) {
  const { getNode } = useReactFlow()

  // Bump the editor key only on the discrete open transition so reopening a
  // node re-seeds from the latest flow data without disturbing typing.
  const prevOpenRef = useRef(false)
  const [openToken, setOpenToken] = useState(0)
  const isOpening = open && !prevOpenRef.current
  const renderToken = openToken + (isOpening ? 1 : 0)

  useEffect(() => {
    if (isOpening) {
      setOpenToken((token) => token + 1)
    }
    prevOpenRef.current = open
  }, [isOpening, open])

  const activeNodeId = activeNode?.id
  const emailDetails =
    getSupacrmReminder(activeNode?.data.details) ||
    getSupacrmDataRequest(activeNode?.data.details) ||
    getSupacrmOperator(activeNode?.data.details) ||
    getSupacrmForm(activeNode?.data.details) ||
    getSupacrmCheckout(activeNode?.data.details) ||
    getSupacrmFulfillment(activeNode?.data.details)
      ? activeNode?.data.details
      : undefined
  // Read the latest node data at open time instead of trusting the stale
  // id-only store snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: getNode is stable; re-read only on open/node changes
  const freshDetails = useMemo(
    () =>
      activeNodeId
        ? ((getNode(activeNodeId) as FlowNode | null)?.data.details ??
          activeNode?.data.details)
        : undefined,
    [activeNodeId, renderToken, emailDetails],
  )

  return open && activeNode && freshDetails !== undefined ? (
    <NodeDetailSheetContent
      activeNode={activeNode}
      freshDetails={freshDetails}
      onOpenChange={onOpenChange}
      open={open}
      openToken={renderToken}
    />
  ) : null
}

export const NodeDetailSheetContent = memo(
  ({
    activeNode,
    freshDetails,
    open,
    openToken,
    onOpenChange,
  }: {
    activeNode: FlowNode
    freshDetails: FlowNode["data"]["details"]
    open: boolean
    openToken: number
    onOpenChange: (open: boolean) => void
  }) => {
    // The editor upgrades legacy spreadsheet steps to variable tokens once, when
    // it seeds its form (and child editors capture their initial value). That
    // conversion needs the custom-field lookup, so wait until the query has
    // finished loading before mounting — `isFetched` flips true after the
    // fetch settles (success or failure), so this never deadlocks.
    const customFieldsInitialized = useCustomFields(useWorkspaceId()).isFetched
    const isReminder = Boolean(getSupacrmReminder(freshDetails))
    const isDataRequest = Boolean(getSupacrmDataRequest(freshDetails))
    const isOperator = Boolean(getSupacrmOperator(freshDetails))
    const isProduct = Boolean(getSupacrmProduct(freshDetails))
    const isVariable = Boolean(getSupacrmVariable(freshDetails))
    const isFulfillment = Boolean(getSupacrmFulfillment(freshDetails))
    const isCheckout = Boolean(getSupacrmCheckout(freshDetails))
    const isForm = Boolean(getSupacrmForm(freshDetails))

    return (
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent className="flex flex-col gap-0" side="left">
          <SheetTitle>
            <NodeNameEditor activeNode={activeNode} />
          </SheetTitle>
          <SheetDescription />
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            {isReminder && (
              <SupacrmReminderEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isDataRequest && (
              <SupacrmDataRequestEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isOperator && (
              <SupacrmOperatorEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isFulfillment && (
              <SupacrmFulfillmentEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isCheckout && (
              <SupacrmCheckoutEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isForm && (
              <SupacrmFormEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isVariable && (
              <SupacrmVariableEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {isProduct && (
              <SupacrmProductEditor
                key={`${activeNode.id}:${openToken}`}
                nodeDetails={
                  freshDetails as SendMessageNodeSchema["data"]["details"]
                }
                nodeId={activeNode.id}
              />
            )}
            {!(
              isReminder ||
              isDataRequest ||
              isOperator ||
              isProduct ||
              isVariable ||
              isForm ||
              isCheckout ||
              isFulfillment
            ) &&
              customFieldsInitialized && (
                <NodeEditor
                  key={`${activeNode.id}:${openToken}`}
                  nodeDetails={freshDetails}
                  nodeId={activeNode.id}
                  nodeType={activeNode.type as NodeType}
                />
              )}
            {!(
              isReminder ||
              isDataRequest ||
              isOperator ||
              isProduct ||
              isVariable ||
              isForm ||
              isCheckout ||
              isFulfillment ||
              customFieldsInitialized
            ) && (
              <div className="flex flex-1 items-center justify-center">
                <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    )
  },
)
