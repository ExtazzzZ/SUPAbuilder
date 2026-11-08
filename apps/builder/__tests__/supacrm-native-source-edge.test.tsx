// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

let root: Root | undefined
let host: HTMLDivElement
const render = (view: React.ReactNode) => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(view))
}
const cleanup = () => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
}
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

import { type EdgeProps, Position } from "@xyflow/react"
import { afterEach, expect, test, vi } from "vitest"
import ButtonEdge from "../src/features/flows/react-flow/edges/button-edge"

const ports = vi.hoisted(() => ({ remove: vi.fn() }))
vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => children,
  EdgeToolbar: ({ children }: { children: React.ReactNode }) => children,
  useReactFlow: () => ({ deleteElements: ports.remove }),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const edge: EdgeProps = {
  id: "edge",
  source: "one",
  target: "two",
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  data: { isHovered: true },
  selected: false,
  selectable: true,
  deletable: true,
  animated: false,
  type: "button",
}
test("readonly source edge offers no delete action", () => {
  render(<ButtonEdge {...edge} deletable={false} />)
  expect(host.querySelector('button[aria-label="Delete edge"]')).toBeNull()
  expect(ports.remove).not.toHaveBeenCalled()
})
test("editable legacy edge still deletes the selected edge", () => {
  render(<ButtonEdge {...edge} />)
  act(() =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Delete edge"]')
      ?.click(),
  )
  expect(ports.remove).toHaveBeenCalledWith({ edges: [{ id: "edge" }] })
})
