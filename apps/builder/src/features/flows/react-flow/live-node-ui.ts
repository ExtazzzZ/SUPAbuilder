import type { Node } from "@xyflow/react"

/** Persistent settings/history replace graph content, while surviving nodes retain their live UI state. */
export function mergeLiveNodeUi<T extends Node>(
  persistent: T,
  live: T | undefined,
): T {
  if (!live) {
    return persistent
  }
  const {
    selected: _selected,
    dragging: _dragging,
    resizing: _resizing,
    width: _width,
    height: _height,
    data,
    ...content
  } = persistent as T & {
    dragging?: boolean
    resizing?: boolean
    width?: number
    height?: number
  }
  const { forceToolbarVisible: _forceToolbarVisible, ...persistentData } = data
  const ui: Record<string, unknown> = {}
  const liveNode = live as T & {
    dragging?: boolean
    resizing?: boolean
    width?: number
    height?: number
  }
  for (const key of [
    "selected",
    "dragging",
    "resizing",
    "width",
    "height",
  ] as const) {
    if (Object.hasOwn(liveNode, key)) {
      ui[key] = liveNode[key]
    }
  }
  const dataUi = Object.hasOwn(live.data, "forceToolbarVisible")
    ? { forceToolbarVisible: live.data.forceToolbarVisible }
    : {}
  // Persistent absence is authoritative; never carry arbitrary live persistent keys forward.
  return { ...content, ...ui, data: { ...persistentData, ...dataUi } } as T
}
