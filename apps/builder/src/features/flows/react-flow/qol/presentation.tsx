"use client"

import type { FlowNode, NodeType } from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  type EdgeProps,
  type NodeProps,
  Position,
  ViewportPortal,
} from "@xyflow/react"
import { useTranslations } from "next-intl"
import { createContext, useContext, useLayoutEffect, useRef } from "react"
import ButtonEdge from "../edges/button-edge"
import { NodeViewer } from "../nodes/viewer"
import type { CollapsedSectionView } from "./section-view"

export const FlowQolPresentationContext =
  createContext<CollapsedSectionView | null>(null)

export function QolNodeViewer(props: NodeProps) {
  const view = useContext(FlowQolPresentationContext)
  const hidden = view?.hiddenNodeIds.has(props.id)
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const wrapper =
      contentRef.current?.closest<HTMLElement>(".react-flow__node")
    if (!(hidden && wrapper)) {
      return
    }
    // DOM-only presentation: never add hidden/focusable flags to canonical nodes.
    const previousTabIndex = wrapper.getAttribute("tabindex")
    const previousAriaHidden = wrapper.getAttribute("aria-hidden")
    const previousPointerEvents = wrapper.style.pointerEvents
    wrapper.setAttribute("inert", "")
    wrapper.setAttribute("tabindex", "-1")
    wrapper.setAttribute("aria-hidden", "true")
    wrapper.style.pointerEvents = "none"
    return () => {
      wrapper.removeAttribute("inert")
      if (previousTabIndex === null) {
        wrapper.removeAttribute("tabindex")
      } else {
        wrapper.setAttribute("tabindex", previousTabIndex)
      }
      if (previousAriaHidden === null) {
        wrapper.removeAttribute("aria-hidden")
      } else {
        wrapper.setAttribute("aria-hidden", previousAriaHidden)
      }
      wrapper.style.pointerEvents = previousPointerEvents
    }
  }, [hidden])
  return (
    <div
      className={hidden ? "flow-qol-hidden" : undefined}
      ref={contentRef}
      style={
        hidden ? { visibility: "hidden", pointerEvents: "none" } : undefined
      }
    >
      <NodeViewer
        data={
          {
            ...props.data,
            ...(hidden ? { forceToolbarVisible: false } : {}),
          } as FlowNode["data"]
        }
        id={props.id}
        type={props.type as NodeType}
      />
    </div>
  )
}

export function QolButtonEdge(props: EdgeProps) {
  const view = useContext(FlowQolPresentationContext)
  if (view?.hiddenEdgeIds.has(props.id)) {
    return null
  }
  const geometry = view?.edgePositions.get(props.id)
  return (
    <ButtonEdge
      {...props}
      {...geometry}
      sourcePosition={
        geometry?.sourceX === undefined ? props.sourcePosition : Position.Right
      }
      targetPosition={
        geometry?.targetX === undefined ? props.targetPosition : Position.Left
      }
    />
  )
}

export function CollapsedSections({
  view,
  onExpand,
}: {
  view: CollapsedSectionView
  onExpand: (id: string) => void
}) {
  const t = useTranslations("flowsQol")
  return (
    <ViewportPortal>
      {view.sections.map((section) => (
        <div
          className="nodrag nopan pointer-events-auto absolute rounded-md border-2 border-primary bg-background shadow-md"
          data-testid="flow-qol-collapsed-section"
          key={section.id}
          style={{
            transform: `translate(${section.x}px, ${section.y}px)`,
            width: section.width,
            height: section.height,
          }}
        >
          <Button
            aria-label={t("expandSection", { title: section.title })}
            className="h-12 w-full justify-start"
            onClick={() => onExpand(section.id)}
            variant="ghost"
          >
            ▸ {section.title} ({section.nodeIds.length})
          </Button>
          {section.ports.map((port) => (
            <div
              className="absolute inset-x-0 flex h-5 items-center px-2 text-xs"
              data-edge-id={port.edgeId}
              key={`${port.direction}:${port.edgeId}`}
              style={{ top: port.y - 10 }}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={port.technicalDescription}
              >
                {port.label}
              </span>
              <span
                aria-hidden
                className="absolute size-2 rounded-full bg-primary"
                style={
                  port.direction === "source" ? { right: -5 } : { left: -5 }
                }
              />
            </div>
          ))}
        </div>
      ))}
    </ViewportPortal>
  )
}
