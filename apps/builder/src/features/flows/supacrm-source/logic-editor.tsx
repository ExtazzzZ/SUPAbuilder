/* biome-ignore-all lint/suspicious/noArrayIndexKey: Позиционные authoring edits и operands не имеют собственных ID; формы не хранят состояния. */
"use client"

import type {
  SourceLogicalEditV1,
  SourceLogicProjectionV1,
  SourceProjection,
  SourceTypedExprV1,
} from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
import { useRef } from "react"
import { literalSlots, SourceExpressionEditor } from "./expression-editor"

function editIdentity(edit: SourceLogicalEditV1) {
  const target = edit.target
  return JSON.stringify([
    edit.kind,
    target.scenario_id,
    target.block_id,
    target.path,
    target.start ?? 0,
    target.end ?? 0,
    target.sequence ?? 0,
  ])
}

function editExpressions(edits: SourceLogicalEditV1[]): SourceTypedExprV1[] {
  return edits.flatMap((edit): SourceTypedExprV1[] => {
    if (edit.kind === "guard") {
      return [edit.expression]
    }
    if (edit.kind === "assignment") {
      return edit.operands
    }
    return []
  })
}

/** Редактор авторской логики: сохраняет provenance и не исполняет выражения. */
export function SourceLogicEditor({
  logic,
  baseline,
  projection,
  onChange,
}: {
  logic: SourceLogicProjectionV1
  baseline?: SourceLogicProjectionV1
  projection: SourceProjection
  onChange: (logic: SourceLogicProjectionV1) => void
}) {
  const t = useTranslations("supacrmSource.logic")
  const identities = logic.edits.map(editIdentity)
  const scope = JSON.stringify([logic.source_hash, [...identities].sort()])
  const initialCatalog = useRef({
    scope,
    slots: literalSlots(editExpressions(logic.edits)),
  })
  // Каталог исходных handles переживает замену последнего literal_slot внутри AST.
  // При смене исходника или адресов правок ссылки предыдущего контекста отбрасываются.
  if (initialCatalog.current.scope !== scope) {
    initialCatalog.current = {
      scope,
      slots: literalSlots(editExpressions(logic.edits)),
    }
  }
  const baselineEdits =
    baseline?.source_hash === logic.source_hash
      ? baseline.edits.filter((edit) => identities.includes(editIdentity(edit)))
      : []
  const slots = literalSlots([
    ...literalSlots(editExpressions(baselineEdits)),
    ...initialCatalog.current.slots,
    ...editExpressions(logic.edits),
  ])
  const targetValue = (value: string | null | undefined) => {
    if (value === null) {
      return "terminal"
    }
    if (value === undefined) {
      return "missing"
    }
    return `block:${value}`
  }
  const writable = projection.symbols.filter(
    (symbol) =>
      symbol.policy === "state" &&
      symbol.declaration?.sensitivity !== "secret" &&
      symbol.operations.includes("set"),
  )
  const seed: SourceTypedExprV1 = slots[0] ?? { kind: "list", items: [] }
  const update = (index: number, edit: SourceLogicalEditV1) =>
    onChange({
      ...logic,
      publishable: false,
      edits: logic.edits.map((item, position) =>
        position === index ? edit : item,
      ),
    })
  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <h2 className="font-semibold">{t("title")}</h2>
      <p>{t("description")}</p>
      <p>
        {t("sourceHash")}: <code>{logic.source_hash}</code>
      </p>
      {logic.edits.length === 0 && <p>{t("empty")}</p>}
      {logic.edits.map((edit, index) => (
        <fieldset
          className="flex flex-col gap-3 rounded border p-3"
          key={`${edit.kind}:${edit.target.scenario_id}:${edit.target.block_id}:${edit.target.path}:${edit.target.sequence}:${index}`}
        >
          <legend>{t(edit.kind)}</legend>
          <dl aria-label={t("provenance")}>
            {Object.entries(edit.target).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
            <div>
              <dt>{t("sourceHash")}</dt>
              <dd>{edit.expected_source_hash}</dd>
            </div>
          </dl>
          {edit.kind === "guard" && (
            <SourceExpressionEditor
              expression={edit.expression}
              onChange={(expression) => update(index, { ...edit, expression })}
              path={`edits.${index}.expression`}
              projection={projection}
              slots={slots}
            />
          )}
          {edit.kind === "assignment" && (
            <>
              <label>
                {t("symbol")}
                <select
                  name={`edits.${index}.symbol_id`}
                  onChange={(event) => {
                    if (
                      writable.some(
                        (symbol) => symbol.id === event.target.value,
                      )
                    ) {
                      update(index, { ...edit, symbol_id: event.target.value })
                    }
                  }}
                  value={edit.symbol_id}
                >
                  {!writable.some((symbol) => symbol.id === edit.symbol_id) && (
                    <option disabled value={edit.symbol_id}>
                      {t("unavailableSymbol")}
                    </option>
                  )}
                  {writable.map((symbol) => (
                    <option key={symbol.id} value={symbol.id}>
                      {[
                        symbol.name,
                        symbol.id,
                        symbol.scope,
                        symbol.valueType,
                        symbol.owner,
                        symbol.policy,
                        symbol.operations.join(", "),
                        ...Object.entries(symbol.declaration ?? {}).map(
                          ([key, value]) => `${key}=${String(value)}`,
                        ),
                      ].join(" · ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("mode")}
                <select
                  name={`edits.${index}.mode`}
                  onChange={(event) => {
                    const mode = ["set", "+", "-"] as const
                    const selected = mode.find(
                      (value) => value === event.target.value,
                    )
                    if (selected) {
                      update(index, { ...edit, mode: selected })
                    }
                  }}
                  value={edit.mode}
                >
                  {["set", "+", "-"].map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              {edit.operands.map((operand, position) => (
                <div key={`operand.${position}`}>
                  <SourceExpressionEditor
                    expression={operand}
                    onChange={(expression) =>
                      update(index, {
                        ...edit,
                        operands: edit.operands.map((item, offset) =>
                          offset === position ? expression : item,
                        ),
                      })
                    }
                    path={`edits.${index}.operands.${position}`}
                    projection={projection}
                    slots={slots}
                  />
                  <button
                    disabled={edit.operands.length <= 1}
                    onClick={() =>
                      update(index, {
                        ...edit,
                        operands: edit.operands.filter(
                          (_, offset) => offset !== position,
                        ),
                      })
                    }
                    type="button"
                  >
                    {t("remove")}
                  </button>
                </div>
              ))}
              <button
                disabled={edit.operands.length >= 2}
                onClick={() =>
                  update(index, { ...edit, operands: [...edit.operands, seed] })
                }
                type="button"
              >
                {t("add")}
              </button>
            </>
          )}
          {edit.kind === "transition" && (
            <>
              <dl aria-label={t("originalPort")}>
                {Object.entries(edit.port).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value === null ? "null" : String(value)}</dd>
                  </div>
                ))}
              </dl>
              <label>
                {t("target")}
                <select
                  name={`edits.${index}.target_block_id`}
                  onChange={(event) => {
                    if (event.target.value === "terminal") {
                      update(index, { ...edit, target_block_id: null })
                    } else {
                      const node = projection.nodes.find(
                        (node) =>
                          `block:${node.sourceId}` === event.target.value,
                      )
                      if (node) {
                        update(index, {
                          ...edit,
                          target_block_id: node.sourceId,
                        })
                      }
                    }
                  }}
                  value={targetValue(edit.target_block_id)}
                >
                  {edit.target_block_id === undefined && (
                    <option disabled value="missing">
                      {t("missingTarget")}
                    </option>
                  )}
                  {edit.target_block_id != null &&
                    !projection.nodes.some(
                      (node) => node.sourceId === edit.target_block_id,
                    ) && (
                      <option disabled value={`block:${edit.target_block_id}`}>
                        {t("missingTarget")} · {edit.target_block_id}
                      </option>
                    )}
                  <option value="terminal">{t("terminal")}</option>
                  {projection.nodes.map((node) => (
                    <option
                      key={node.sourceId}
                      value={`block:${node.sourceId}`}
                    >
                      {node.label} · {node.sourceId}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </fieldset>
      ))}
    </section>
  )
}
