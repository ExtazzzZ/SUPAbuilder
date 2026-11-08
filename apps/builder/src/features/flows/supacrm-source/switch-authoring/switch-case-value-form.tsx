"use client"

import type { sourcePortV1Schema } from "@chatbotx.io/flow-config"
import type { z } from "zod"
import {
  OrdinaryMessageForm,
  type OrdinaryMessageFormProps,
} from "../message-authoring/ordinary-message-form"

/** Локальная модель формы, не wire DTO; verified var/eq/str проверяет родитель. */
export interface SwitchCaseValueFormProps {
  caseId: string
  commitBlocked?: boolean
  editable: boolean
  labels: OrdinaryMessageFormProps["labels"] & {
    title: string
    value: string
    caseId: string
    position: string
    port: string
    name: string
    unnamedPort: string
    target: string
    terminal: string
    path: string
    sequence: string
    scenario: string
    block: string
  }
  onCommit: (text: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  pending: boolean
  port: z.infer<typeof sourcePortV1Schema>
  position: number
  readOnlyReason?: string
  text: string
}

/** Меняет только строковый черновик existing case; порядок и порты не редактируются. */
export function SwitchCaseValueForm({
  caseId,
  position,
  port,
  text,
  editable,
  readOnlyReason,
  pending,
  commitBlocked,
  labels,
  onCommit,
  onDirtyChange,
}: SwitchCaseValueFormProps) {
  const scope = JSON.stringify([
    caseId,
    port.scenario_id,
    port.block_id,
    port.source_path,
    port.sequence,
    port.name,
    port.target_block_id,
  ])
  return (
    <section
      aria-label={labels.title}
      className="flex flex-col gap-3"
      data-case-id={caseId}
      data-case-position={position}
    >
      <dl aria-label={labels.port}>
        <div>
          <dt>{labels.caseId}</dt>
          <dd>{caseId}</dd>
        </div>
        <div>
          <dt>{labels.position}</dt>
          <dd>{position}</dd>
        </div>
        <div>
          <dt>{labels.scenario}</dt>
          <dd>{port.scenario_id}</dd>
        </div>
        <div>
          <dt>{labels.block}</dt>
          <dd>{port.block_id}</dd>
        </div>
        <div>
          <dt>{labels.path}</dt>
          <dd>{port.source_path}</dd>
        </div>
        <div>
          <dt>{labels.sequence}</dt>
          <dd>{port.sequence}</dd>
        </div>
        <div>
          <dt>{labels.name}</dt>
          <dd data-port-name-kind={port.name === null ? "null" : "string"}>
            {port.name === null ? labels.unnamedPort : `«${port.name}»`}
          </dd>
        </div>
        <div>
          <dt>{labels.target}</dt>
          <dd
            data-port-target-kind={
              port.target_block_id === null ? "null" : "string"
            }
          >
            {port.target_block_id === null
              ? labels.terminal
              : `«${port.target_block_id}»`}
          </dd>
        </div>
      </dl>
      <OrdinaryMessageForm
        commitBlocked={commitBlocked}
        editable={editable}
        fieldId={`switch-case-value:${caseId}`}
        key={scope}
        label={labels.value}
        labels={labels}
        onCommit={onCommit}
        onDirtyChange={onDirtyChange}
        pending={pending}
        readOnlyReason={readOnlyReason}
        text={text}
      />
    </section>
  )
}
