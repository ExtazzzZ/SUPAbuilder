"use client"

import {
  type FlowNavigationEdge,
  type FlowNavigationNode,
  type FlowSection,
  queryFlowGraph,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { describeFlowConnection } from "./connection-label"

type Props = {
  nodes: readonly (FlowNavigationNode & { selected?: boolean })[]
  edges: readonly FlowNavigationEdge[]
  collapsed: readonly string[]
  onFocus: (nodeId: string) => void
  onToggleSection: (sectionId: string) => void
  onAssignSection: (section: FlowSection) => void
  onRemoveSection: (sectionId: string) => void
  disabled?: boolean
}

export function FlowNavigationPanel({
  nodes,
  edges,
  collapsed,
  onFocus,
  onToggleSection,
  onAssignSection,
  onRemoveSection,
  disabled,
}: Props) {
  const t = useTranslations("flowsQol")
  const [query, setQuery] = useState("")
  const [title, setTitle] = useState("")
  const [sectionId, setSectionId] = useState("")
  const [focusedId, setFocusedId] = useState<string>()
  const result = useMemo(
    () => queryFlowGraph({ nodes, edges, query }),
    [nodes, edges, query],
  )
  const selectedIds = nodes
    .filter((node) => node.selected)
    .map((node) => node.id)
  const connections = edges.filter(
    (edge) => edge.source === focusedId || edge.target === focusedId,
  )
  const focus = (nodeId: string) => {
    setFocusedId(nodeId)
    onFocus(nodeId)
  }

  return (
    <aside
      aria-label={t("title")}
      className="nodrag nopan nowheel w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-background p-3 shadow-sm"
      data-testid="flow-qol-panel"
    >
      <h2 className="mb-2 font-semibold text-sm">{t("title")}</h2>
      <Input
        aria-label={t("search")}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search")}
        type="search"
        value={query}
      />
      <section
        aria-label={t("results")}
        className="mt-2 max-h-[30vh] space-y-1 overflow-y-auto"
      >
        {result.data.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        )}
        {result.data.map((node) => (
          <Button
            className="h-auto w-full justify-start whitespace-normal text-start"
            key={node.nodeId}
            onClick={() => focus(node.nodeId)}
            size="sm"
            variant="ghost"
          >
            <span className="min-w-0">
              <span className="block">{node.label}</span>
              <span className="block break-all text-muted-foreground text-xs">
                {node.type} · {node.nodeId}
              </span>
            </span>
          </Button>
        ))}
      </section>
      {focusedId && (
        <section
          aria-label={t("connections")}
          className="mt-2 max-h-32 overflow-y-auto border-t pt-2"
        >
          <h3 className="font-semibold text-xs">{t("connections")}</h3>
          {connections.length === 0 && (
            <p className="text-muted-foreground text-xs">
              {t("noConnections")}
            </p>
          )}
          {connections.map((edge) => {
            const connection = describeFlowConnection(nodes, edge)
            return (
              <Button
                className="h-auto w-full justify-start whitespace-normal break-words text-start text-xs"
                data-edge-id={edge.id}
                key={edge.id}
                onClick={() =>
                  focus(edge.source === focusedId ? edge.target : edge.source)
                }
                size="sm"
                title={connection.technicalDescription}
                variant="ghost"
              >
                {connection.label}
              </Button>
            )
          })}
        </section>
      )}
      <section
        aria-label={t("sections")}
        className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t pt-2"
      >
        <h3 className="font-semibold text-xs">{t("sections")}</h3>
        {result.sections.map((section) => (
          <div className="space-y-1" key={section.id}>
            <div className="flex items-center gap-1">
              <Button
                aria-expanded={!collapsed.includes(section.id)}
                className="min-w-0 flex-1 justify-start truncate"
                onClick={() => onToggleSection(section.id)}
                size="sm"
                variant="secondary"
              >
                {collapsed.includes(section.id) ? "▸" : "▾"} {section.title} (
                {section.nodeIds.length})
              </Button>
              <Button
                aria-label={t("editSection", { title: section.title })}
                onClick={() => {
                  setSectionId(section.id)
                  setTitle(section.title)
                }}
                size="sm"
                variant="ghost"
              >
                ✎
              </Button>
              <Button
                aria-label={t("removeSection", { title: section.title })}
                disabled={disabled}
                onClick={() => onRemoveSection(section.id)}
                size="sm"
                variant="ghost"
              >
                ×
              </Button>
            </div>
            {!collapsed.includes(section.id) &&
              section.nodeIds.map((nodeId) => (
                <Button
                  className="h-auto w-full justify-start whitespace-normal text-start text-xs"
                  key={nodeId}
                  onClick={() => focus(nodeId)}
                  size="sm"
                  variant="ghost"
                >
                  {(nodes.find((node) => node.id === nodeId)?.data
                    ?.name as string) ?? nodeId}
                </Button>
              ))}
          </div>
        ))}
      </section>
      <form
        className="mt-2 space-y-2 border-t pt-2"
        onSubmit={(event) => {
          event.preventDefault()
          const existing = result.sections.find(
            (section) => section.id === sectionId,
          )
          const nodeIds = selectedIds.length
            ? selectedIds
            : (existing?.nodeIds ?? [])
          if (!(title.trim() && nodeIds.length)) {
            return
          }
          onAssignSection({
            id: sectionId || crypto.randomUUID(),
            title: title.trim(),
            nodeIds,
          })
          setTitle("")
          setSectionId("")
        }}
      >
        <Input
          aria-label={t("sectionName")}
          maxLength={255}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("sectionName")}
          value={title}
        />
        <p className="text-muted-foreground text-xs">
          {t("selected", { count: selectedIds.length })}
        </p>
        <div className="flex gap-1">
          <Button
            disabled={
              disabled || !title.trim() || !(selectedIds.length || sectionId)
            }
            size="sm"
            type="submit"
          >
            {sectionId ? t("saveSection") : t("createSection")}
          </Button>
          {sectionId && (
            <Button
              onClick={() => {
                setSectionId("")
                setTitle("")
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("cancel")}
            </Button>
          )}
        </div>
      </form>
    </aside>
  )
}
