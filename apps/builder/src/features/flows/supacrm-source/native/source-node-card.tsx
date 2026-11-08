"use client"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { type NodeProps, Position } from "@xyflow/react"
import { MessageCircleMoreIcon, WorkflowIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseHandle } from "@/components/base-handle"
import type { SourceCanvasNode, SourceCanvasNodeData } from "./types"

const kindLabelKeys = {
  cancel_event: "kinds.cancel_event",
  http_request: "kinds.http_request",
  send_message: "kinds.send_message",
  set_vars: "kinds.set_vars",
  set_timer: "kinds.set_timer",
  basic: "kinds.basic",
  notify_managers: "kinds.notify_managers",
  switch: "kinds.switch",
  note: "kinds.note",
  exec_sq: "kinds.exec_sq",
  portal_out: "kinds.portal_out",
  read_google_sheets: "kinds.read_google_sheets",
  set_cell_google_sheets: "kinds.set_cell_google_sheets",
  portal_in: "kinds.portal_in",
  user_input: "kinds.user_input",
  chat_message: "kinds.chat_message",
  ask_gpt: "kinds.ask_gpt",
  add_row_google_sheets: "kinds.add_row_google_sheets",
  switch_context: "kinds.switch_context",
  llm_classification: "kinds.llm_classification",
  default_answer: "kinds.default_answer",
  webhook: "kinds.webhook",
  random_choice: "kinds.random_choice",
  communicate_ai: "kinds.communicate_ai",
  first_message: "kinds.first_message",
  save_file_attachment: "kinds.save_file_attachment",
  is_group_member: "kinds.is_group_member",
  vk_market_item_message: "kinds.vk_market_item_message",
  add_to_list: "kinds.add_to_list",
  pre_filter_continue: "kinds.pre_filter_continue",
  pre_filter: "kinds.pre_filter",
  pre_filter_break: "kinds.pre_filter_break",
} as const satisfies Record<SourceCanvasNodeData["sourceKind"], string>

/** Штатная Card/BaseHandle оболочка; никакие legacy steps или runtime effects не создаются. */
export function SourceNodeCard({
  id,
  data,
  selected,
}: NodeProps<SourceCanvasNode>) {
  const t = useTranslations("supacrmNativeSource.card")
  const kindLabel = t(kindLabelKeys[data.sourceKind])
  const title =
    data.label && data.label !== data.sourceKind ? data.label : kindLabel
  const Icon =
    data.sourceKind === "send_message" ? MessageCircleMoreIcon : WorkflowIcon
  return (
    <Card
      className={`w-72 gap-0 p-0 ${selected ? "ring-2 ring-primary" : ""}`}
      data-testid="native-source-node-card"
    >
      <CardHeader className="relative p-4">
        <BaseHandle
          id={id}
          isConnectable={false}
          isConnectableEnd={false}
          isConnectableStart={false}
          position={Position.Left}
          type="target"
        />
        <CardTitle className="flex items-center gap-1">
          <Icon aria-hidden="true" className="size-5 shrink-0" />
          <span className="break-words">{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        <div className="text-muted-foreground text-xs">{kindLabel}</div>
        {data.ports.map((port) => (
          <div
            className="relative w-full text-end text-sm"
            key={port.handleId}
            title={
              port.source.target_block_id === null
                ? t("terminal")
                : t("readOnly")
            }
          >
            <span className="me-4 break-words">
              {port.label === ""
                ? (port.source.name ?? "∅") || t("unnamed")
                : port.label}
            </span>
            <BaseHandle
              id={port.handleId}
              isConnectable={false}
              isConnectableEnd={false}
              isConnectableStart={false}
              position={Position.Right}
              type="source"
            />
          </div>
        ))}
        <p className="text-muted-foreground text-xs">{t("readOnly")}</p>
      </CardContent>
    </Card>
  )
}
