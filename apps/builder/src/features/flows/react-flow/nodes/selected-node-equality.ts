import {
  type FlowNode,
  getSupacrmCheckout,
  getSupacrmDataRequest,
  getSupacrmForm,
  getSupacrmOperator,
  getSupacrmReminder,
} from "@chatbotx.io/flow-config"
import type { ReactFlowState } from "@xyflow/react"
import { isSourceCanvasNode } from "../../supacrm-source/native/projection-adapter"
import type { SourceCanvasNode } from "../../supacrm-source/native/types"

/** Даже неполные source metadata не должны включать legacy форму. */
export function hasSourceDocumentMode(node: unknown): boolean {
  if (typeof node !== "object" || node === null || !("data" in node)) {
    return false
  }
  const data = node.data
  return (
    typeof data === "object" &&
    data !== null &&
    "documentMode" in data &&
    data.documentMode === "source"
  )
}

// Select only the selected node from the store
export const selectSelectedNode = (
  state: ReactFlowState,
): FlowNode | SourceCanvasNode | null =>
  (state.nodes.find((node) => node.selected) as FlowNode | SourceCanvasNode) ||
  null

// Re-render the detail sheet only when the selected node's identity or its
// display name changes. The big editor form below streams its keystrokes into
// `data.details`; ignoring those here keeps the form from re-seeding while the
// user types. A rename is a discrete, explicit change we DO want to surface so
// the sheet title (NodeNameEditor) syncs immediately instead of waiting for a
// full remount (F5).
export const selectedNodeEqualityFn = (
  a: FlowNode | SourceCanvasNode | null,
  b: FlowNode | SourceCanvasNode | null,
): boolean => {
  if (a === b) {
    return true
  }
  if (hasSourceDocumentMode(a) || hasSourceDocumentMode(b)) {
    return (
      isSourceCanvasNode(a) &&
      isSourceCanvasNode(b) &&
      a.id === b.id &&
      a.data.scopeKey === b.data.scopeKey &&
      a.data.label === b.data.label
    )
  }
  if (isSourceCanvasNode(a) || isSourceCanvasNode(b)) {
    return false
  }
  // Email settings commit discretely; history/adoption must refresh their mounted inspector.
  if (
    getSupacrmReminder(a?.data.details) ||
    getSupacrmReminder(b?.data.details) ||
    getSupacrmDataRequest(a?.data.details) ||
    getSupacrmDataRequest(b?.data.details) ||
    getSupacrmOperator(a?.data.details) ||
    getSupacrmOperator(b?.data.details) ||
    getSupacrmForm(a?.data.details) ||
    getSupacrmForm(b?.data.details) ||
    getSupacrmCheckout(a?.data.details) ||
    getSupacrmCheckout(b?.data.details)
  ) {
    return (
      a?.id === b?.id &&
      a?.data.name === b?.data.name &&
      a?.data.details === b?.data.details
    )
  }
  return a?.id === b?.id && a?.data.name === b?.data.name
}
