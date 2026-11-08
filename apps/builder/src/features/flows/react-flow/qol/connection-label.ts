import type {
  FlowNavigationEdge,
  FlowNavigationNode,
} from "@chatbotx.io/flow-config"

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const buttonLabel = (
  buttons: unknown,
  handleId: string | null | undefined,
): string | undefined => {
  if (!(Array.isArray(buttons) && handleId)) {
    return
  }
  for (const button of buttons) {
    const value = record(button)
    if (
      value?.id === handleId &&
      typeof value.label === "string" &&
      value.label.trim()
    ) {
      return value.label.trim()
    }
  }
  return
}

/** Read only known display fields, never arbitrary action payloads or headers. */
const outputLabel = (details: unknown, handleId: string | null | undefined) => {
  const value = record(details)
  if (!value) {
    return
  }
  const quickReply = buttonLabel(value.quickReplies, handleId)
  if (quickReply) {
    return quickReply
  }
  if (!Array.isArray(value.steps)) {
    return
  }
  for (const step of value.steps) {
    const message = record(step)
    const label = buttonLabel(message?.buttons, handleId)
    if (label) {
      return label
    }
    if (!Array.isArray(message?.cards)) {
      continue
    }
    for (const card of message.cards) {
      const cardLabel = buttonLabel(record(card)?.buttons, handleId)
      if (cardLabel) {
        return cardLabel
      }
    }
  }
  return
}

const nodeLabel = (node: FlowNavigationNode | undefined, id: string) =>
  typeof node?.data?.name === "string" && node.data.name.trim()
    ? node.data.name.trim()
    : id

export function describeFlowConnection(
  nodes: readonly FlowNavigationNode[],
  edge: FlowNavigationEdge,
) {
  const source = nodes.find((node) => node.id === edge.source)
  const target = nodes.find((node) => node.id === edge.target)
  const output = outputLabel(source?.data?.details, edge.sourceHandle)
  return {
    label: `${nodeLabel(source, edge.source)}${output ? ` · ${output}` : ""} → ${nodeLabel(target, edge.target)}`,
    technicalDescription: `${edge.id} · ${edge.source} [${edge.sourceHandle ?? "∅"}] → ${edge.target} [${edge.targetHandle ?? "∅"}]`,
  }
}
