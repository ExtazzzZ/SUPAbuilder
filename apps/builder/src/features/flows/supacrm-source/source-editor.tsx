"use client"

import {
  compileSourceProjection,
  type SourceNode,
  type SourceProjection,
} from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
import { useState } from "react"

const declarationFields = [
  "rawKey",
  "definitionRevision",
  "protected",
  "lifetime",
  "defaultPolicy",
  "sensitivity",
  "readStrategy",
  "writeStrategy",
  "resetPolicy",
  "units",
] as const

/** Редактирует безопасную проекцию; исполнение и cursor принадлежат backend. */
export function SupacrmSourceEditor({
  projection,
  onChange,
  onPublish,
  selectedSourceId,
  onSelectSource,
  showPublish = true,
  showMessageDraft = true,
}: {
  projection: SourceProjection
  onChange: (projection: SourceProjection) => void
  showPublish?: boolean
  showMessageDraft?: boolean
  onPublish?: (projection: SourceProjection) => void
  selectedSourceId?: string
  onSelectSource?: (sourceId: string) => void
}) {
  const t = useTranslations("supacrmSource")
  const [internalSelectedId, setSelectedId] = useState(
    projection.nodes[0]?.sourceId ?? "",
  )
  const selectedId = selectedSourceId ?? internalSelectedId
  const [symbolId, setSymbolId] = useState("")
  const [operation, setOperation] = useState("read")
  const node = projection.nodes.find((item) => item.sourceId === selectedId)
  const symbol = projection.symbols.find((item) => item.id === symbolId)
  const compile = () => {
    try {
      return compileSourceProjection(projection)
    } catch {
      return {
        projection,
        diagnostics: [
          { code: "invalid_projection", message: t("invalidProjection") },
        ],
        publishable: false,
      }
    }
  }
  const compiled = compile()
  const update = (patch: Partial<SourceNode>) => {
    if (!node) {
      return
    }
    onChange({
      ...projection,
      nodes: projection.nodes.map((item) =>
        item.sourceId === node.sourceId ? { ...item, ...patch } : item,
      ),
    })
  }
  const allowedOperations = (symbol?.operations ?? []).filter((item) => {
    if (symbol?.policy === "secret_ref") {
      return false
    }
    if (symbol?.policy === "read_only") {
      return item === "read"
    }
    if (symbol?.policy === "native_command") {
      return item === "read" || item === "command"
    }
    return true
  })
  const selectedOperation =
    allowedOperations.find((item) => item === operation) ?? allowedOperations[0]

  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="text-muted-foreground text-sm">{t("description")}</p>
      <label className="flex flex-col gap-1">
        {t("node")}
        <select
          name="sourceId"
          onChange={(event) => {
            setSelectedId(event.target.value)
            onSelectSource?.(event.target.value)
          }}
          value={selectedId}
        >
          {projection.nodes.map((item) => (
            <option key={item.sourceId} value={item.sourceId}>
              {item.label} · {item.kind} · {item.sourceId}
            </option>
          ))}
        </select>
      </label>
      {node && (
        <>
          <label className="flex flex-col gap-1">
            {t("label")}
            <input
              name="label"
              onChange={(event) => update({ label: event.target.value })}
              value={node.label}
            />
          </label>
          {showMessageDraft && (
            <>
              <label className="flex flex-col gap-1">
                {t("richText")}
                <textarea
                  name="richText"
                  onChange={(event) =>
                    update({
                      content: {
                        ...node.content,
                        richText: event.target.value,
                      },
                    })
                  }
                  value={node.content.richText ?? ""}
                />
              </label>
              <label className="flex flex-col gap-1">
                {t("editMode")}
                <select
                  name="editMode"
                  onChange={(event) =>
                    update({
                      content: {
                        ...node.content,
                        editMode: event.target.value as
                          | "send"
                          | "edit"
                          | "replace",
                      },
                    })
                  }
                  value={node.content.editMode ?? "send"}
                >
                  <option value="send">{t("modes.send")}</option>
                  <option value="edit">{t("modes.edit")}</option>
                  <option value="replace">{t("modes.replace")}</option>
                </select>
              </label>
            </>
          )}
          <h3 className="font-medium">{t("ports")}</h3>
          <ul>
            {node.ports.map((port) => (
              <li key={port.id}>
                {port.label} · {port.id}
              </li>
            ))}
          </ul>
          <h3 className="font-medium">{t("registry")}</h3>
          <label className="flex flex-col gap-1">
            {t("symbol")}
            <select
              name="symbolId"
              onChange={(event) => {
                setSymbolId(event.target.value)
                setOperation("read")
              }}
              value={symbolId}
            >
              <option value="">{t("chooseSymbol")}</option>
              {projection.symbols.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id} · {item.scope} · {item.valueType} ·{" "}
                  {item.owner} · {item.policy}
                </option>
              ))}
            </select>
          </label>
          {symbol?.declaration && (
            <dl
              aria-label={t("declaration.title")}
              className="grid grid-cols-2 gap-2"
            >
              {declarationFields.map((field) => (
                <div key={field}>
                  <dt>{t(`declaration.${field}`)}</dt>
                  <dd>{String(symbol.declaration?.[field] ?? "")}</dd>
                </div>
              ))}
            </dl>
          )}
          <label className="flex flex-col gap-1">
            {t("operation")}
            <select
              disabled={!symbol}
              name="operation"
              onChange={(event) => setOperation(event.target.value)}
              value={selectedOperation ?? ""}
            >
              {allowedOperations.map((item) => (
                <option key={item} value={item}>
                  {t(`operations.${item}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            data-action="add-binding"
            disabled={!(symbol && selectedOperation)}
            onClick={() => {
              if (symbol && selectedOperation) {
                update({
                  bindings: [
                    ...node.bindings,
                    { symbolId: symbol.id, operation: selectedOperation },
                  ],
                })
              }
            }}
            type="button"
          >
            {t("addBinding")}
          </button>
          <ul>
            {node.bindings.map((binding, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: У обращений нет отдельного ID; строка не хранит внутреннего состояния.
              <li key={`${binding.symbolId}-${binding.operation}-${index}`}>
                {binding.symbolId} · {t(`operations.${binding.operation}`)}
                <button
                  onClick={() =>
                    update({
                      bindings: node.bindings.filter(
                        (_, itemIndex) => index !== itemIndex,
                      ),
                    })
                  }
                  type="button"
                >
                  {t("removeBinding")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {compiled.diagnostics.length > 0 && (
        <div role="alert">
          <h3>{t("diagnostics")}</h3>
          <ul>
            {compiled.diagnostics.map((diagnostic, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Диагностика не имеет ID и не хранит внутреннего состояния.
              <li key={`${diagnostic.code}-${index}`}>
                {diagnostic.code} · {diagnostic.nodeId} · {diagnostic.symbolId}{" "}
                · {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {showPublish && (
        <button
          data-action="publish"
          disabled={!(compiled.publishable && onPublish)}
          onClick={() => {
            if (compiled.publishable) {
              onPublish?.(compiled.projection)
            }
          }}
          type="button"
        >
          {t("publish")}
        </button>
      )}
    </section>
  )
}
