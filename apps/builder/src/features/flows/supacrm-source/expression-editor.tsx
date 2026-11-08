/* biome-ignore-all lint/suspicious/noArrayIndexKey: AST не содержит ID; формы не хранят локального состояния, адресом служит позиция. */
"use client"

import {
  sourceBinaryOperatorsV1 as binaryOperators,
  type SourceProjection,
  type SourceTypedExprV1,
  sourceUnaryOperatorsV1 as unaryOperators,
} from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

export const expressionKinds = [
  "symbol",
  "literal_slot",
  "local",
  "unary",
  "binary",
  "call",
  "conditional",
  "list",
  "tuple",
  "dict",
  "index",
  "lambda",
] as const
type Slot = Extract<SourceTypedExprV1, { kind: "literal_slot" }>
type Local = Extract<SourceTypedExprV1, { kind: "local" }>

/** Собирает только безопасные ссылки, без загрузки или раскрытия значений. */
export function literalSlots(expressions: SourceTypedExprV1[]): Slot[] {
  const slots = new Map<string, Slot>()
  const visit = (expr: SourceTypedExprV1) => {
    switch (expr.kind) {
      case "literal_slot":
        slots.set(`${expr.slot_id}:${expr.declared_type}`, expr)
        break
      case "unary":
        visit(expr.operand)
        break
      case "binary":
        visit(expr.left)
        visit(expr.right)
        break
      case "call":
        for (const argument of expr.arguments) {
          visit(argument)
        }
        break
      case "conditional":
        visit(expr.condition)
        visit(expr.when_true)
        visit(expr.when_false)
        break
      case "list":
      case "tuple":
        for (const item of expr.items) {
          visit(item)
        }
        break
      case "dict":
        for (const entry of expr.entries) {
          visit(entry.key)
          visit(entry.value)
        }
        break
      case "index":
        visit(expr.collection)
        visit(expr.index)
        break
      case "lambda":
        visit(expr.body)
        break
      default:
        break
    }
  }
  for (const expression of expressions) {
    visit(expression)
  }
  return [...slots.values()]
}

export function readableSymbols(projection: SourceProjection) {
  return projection.symbols.filter(
    (symbol) =>
      symbol.policy !== "secret_ref" &&
      symbol.declaration?.sensitivity !== "secret" &&
      symbol.operations.includes("read"),
  )
}

/** Создаёт структуру AST; literal_slot выбирается только из исходных ссылок. */
function newExpression(
  kind: SourceTypedExprV1["kind"],
  seed: SourceTypedExprV1,
  slots: Slot[],
  locals: Local[],
): SourceTypedExprV1 {
  switch (kind) {
    case "symbol":
      return seed.kind === "symbol" ? seed : { kind: "list", items: [] }
    case "literal_slot":
      return slots[0] ?? seed
    case "local":
      return locals[0] ?? seed
    case "unary":
      return { kind, operator: "not", operand: seed }
    case "binary":
      return { kind, operator: "==", left: seed, right: seed }
    case "call":
      return { kind, function_id: "", arguments: [] }
    case "conditional":
      return { kind, condition: seed, when_true: seed, when_false: seed }
    case "list":
    case "tuple":
      return { kind, items: [] }
    case "dict":
      return { kind, entries: [] }
    case "index":
      return { kind, collection: seed, index: seed }
    case "lambda":
      return { kind, parameters: [], body: seed }
    default:
      return seed
  }
}

export function SourceExpressionEditor({
  expression,
  projection,
  slots,
  onChange,
  path = "expression",
  locals = [],
}: {
  expression: SourceTypedExprV1
  projection: SourceProjection
  slots: Slot[]
  onChange: (expression: SourceTypedExprV1) => void
  path?: string
  locals?: Local[]
}) {
  const t = useTranslations("supacrmSource.logic")
  const symbols = readableSymbols(projection)
  const firstSymbol = symbols[0]
  const seed: SourceTypedExprV1 = firstSymbol
    ? { kind: "symbol", symbol_id: firstSymbol.id }
    : (slots[0] ?? { kind: "list", items: [] })
  const child = (
    label: string,
    value: SourceTypedExprV1,
    change: (value: SourceTypedExprV1) => void,
    scope = locals,
    address = label,
  ): ReactNode => (
    <div className="flex flex-col gap-1">
      <span>{t(label)}</span>
      <SourceExpressionEditor
        expression={value}
        locals={scope}
        onChange={change}
        path={`${path}.${address}`}
        projection={projection}
        slots={slots}
      />
    </div>
  )
  const sequence = (
    values: SourceTypedExprV1[],
    change: (values: SourceTypedExprV1[]) => void,
    maximum = Number.POSITIVE_INFINITY,
  ) => (
    <div className="flex flex-col gap-2">
      {values.map((value, index) => (
        <div key={`${path}.${index}`}>
          <SourceExpressionEditor
            expression={value}
            locals={locals}
            onChange={(next) =>
              change(
                values.map((item, position) =>
                  position === index ? next : item,
                ),
              )
            }
            path={`${path}.${index}`}
            projection={projection}
            slots={slots}
          />
          <button
            disabled={values.length <= 0}
            onClick={() =>
              change(values.filter((_, position) => position !== index))
            }
            type="button"
          >
            {t("remove")}
          </button>
        </div>
      ))}
      <button
        disabled={values.length >= maximum}
        onClick={() => change([...values, seed])}
        type="button"
      >
        {t("add")}
      </button>
    </div>
  )
  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
  ) => (
    <label className="flex flex-col gap-1">
      {t(label)}
      <input
        name={`${path}.${label}`}
        onChange={(event) => change(event.target.value)}
        pattern="[A-Za-z_][A-Za-z0-9_]*"
        value={value}
      />
    </label>
  )
  let fields: ReactNode
  switch (expression.kind) {
    case "symbol":
      fields = (
        <label>
          {t("symbol")}
          <select
            name={`${path}.symbol_id`}
            onChange={(event) => {
              if (symbols.some((symbol) => symbol.id === event.target.value)) {
                onChange({ ...expression, symbol_id: event.target.value })
              }
            }}
            value={expression.symbol_id}
          >
            {!symbols.some((symbol) => symbol.id === expression.symbol_id) && (
              <option disabled value={expression.symbol_id}>
                {t("unavailableSymbol")}
              </option>
            )}
            {symbols.map((symbol) => (
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
      )
      break
    case "literal_slot":
      fields = (
        <label>
          {t("literalSlot")}
          <select
            name={`${path}.slot_id`}
            onChange={(event) => {
              const slot = slots[Number(event.target.value)]
              if (slot) {
                onChange({ ...slot })
              }
            }}
            value={slots.findIndex(
              (slot) =>
                slot.slot_id === expression.slot_id &&
                slot.declared_type === expression.declared_type,
            )}
          >
            {slots.map((slot, index) => (
              <option
                key={`${slot.slot_id}:${slot.declared_type}`}
                value={index}
              >
                {slot.slot_id} · {slot.declared_type}
              </option>
            ))}
          </select>
        </label>
      )
      break
    case "local":
      fields = (
        <label>
          {t("local")}
          <select
            name={`${path}.parameter_id`}
            onChange={(event) => {
              if (
                locals.some(
                  (local) => local.parameter_id === event.target.value,
                )
              ) {
                onChange({ ...expression, parameter_id: event.target.value })
              }
            }}
            value={expression.parameter_id}
          >
            {!locals.some(
              (local) => local.parameter_id === expression.parameter_id,
            ) && (
              <option disabled value={expression.parameter_id}>
                {expression.parameter_id}
              </option>
            )}
            {locals.map((local) => (
              <option key={local.parameter_id} value={local.parameter_id}>
                {local.parameter_id}
              </option>
            ))}
          </select>
        </label>
      )
      break
    case "unary":
      fields = (
        <>
          <label>
            {t("operator")}
            <select
              name={`${path}.operator`}
              onChange={(event) => {
                const operator = unaryOperators.find(
                  (value) => value === event.target.value,
                )
                if (operator) {
                  onChange({ ...expression, operator })
                }
              }}
              value={expression.operator}
            >
              {unaryOperators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
          </label>
          {child("operand", expression.operand, (operand) =>
            onChange({ ...expression, operand }),
          )}
        </>
      )
      break
    case "binary":
      fields = (
        <>
          <label>
            {t("operator")}
            <select
              name={`${path}.operator`}
              onChange={(event) => {
                const operator = binaryOperators.find(
                  (value) => value === event.target.value,
                )
                if (operator) {
                  onChange({ ...expression, operator })
                }
              }}
              value={expression.operator}
            >
              {binaryOperators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
          </label>
          {child("left", expression.left, (left) =>
            onChange({ ...expression, left }),
          )}
          {child("right", expression.right, (right) =>
            onChange({ ...expression, right }),
          )}
        </>
      )
      break
    case "call":
      fields = (
        <>
          {field("functionId", expression.function_id, (function_id) =>
            onChange({ ...expression, function_id }),
          )}
          <p>{t("functionValidation")}</p>
          {sequence(expression.arguments, (args) =>
            onChange({ ...expression, arguments: args }),
          )}
        </>
      )
      break
    case "conditional":
      fields = (
        <>
          {child("condition", expression.condition, (condition) =>
            onChange({ ...expression, condition }),
          )}
          {child("whenTrue", expression.when_true, (when_true) =>
            onChange({ ...expression, when_true }),
          )}
          {child("whenFalse", expression.when_false, (when_false) =>
            onChange({ ...expression, when_false }),
          )}
        </>
      )
      break
    case "list":
    case "tuple":
      fields = sequence(expression.items, (items) =>
        onChange({ ...expression, items }),
      )
      break
    case "dict":
      fields = (
        <>
          {expression.entries.map((entry, index) => (
            <div key={`${path}.${index}`}>
              {child(
                "key",
                entry.key,
                (key) =>
                  onChange({
                    ...expression,
                    entries: expression.entries.map((item, position) =>
                      position === index ? { ...item, key } : item,
                    ),
                  }),
                locals,
                `${index}.key`,
              )}
              {child(
                "value",
                entry.value,
                (value) =>
                  onChange({
                    ...expression,
                    entries: expression.entries.map((item, position) =>
                      position === index ? { ...item, value } : item,
                    ),
                  }),
                locals,
                `${index}.value`,
              )}
              <button
                onClick={() =>
                  onChange({
                    ...expression,
                    entries: expression.entries.filter(
                      (_, position) => position !== index,
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
            onClick={() =>
              onChange({
                ...expression,
                entries: [...expression.entries, { key: seed, value: seed }],
              })
            }
            type="button"
          >
            {t("add")}
          </button>
        </>
      )
      break
    case "index":
      fields = (
        <>
          {child("collection", expression.collection, (collection) =>
            onChange({ ...expression, collection }),
          )}
          {child("index", expression.index, (index) =>
            onChange({ ...expression, index }),
          )}
        </>
      )
      break
    case "lambda":
      fields = (
        <>
          <span>{t("parameters")}</span>
          {expression.parameters.map((parameter, index) => (
            <div key={`${path}.parameter.${index}`}>
              {field("local", parameter.parameter_id, (parameter_id) =>
                onChange({
                  ...expression,
                  parameters: expression.parameters.map((item, position) =>
                    position === index ? { ...item, parameter_id } : item,
                  ),
                }),
              )}
              <button
                onClick={() =>
                  onChange({
                    ...expression,
                    parameters: expression.parameters.filter(
                      (_, position) => position !== index,
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
            onClick={() => {
              let index = 1
              while (
                [...locals, ...expression.parameters].some(
                  (parameter) =>
                    parameter.parameter_id === `parameter_${index}`,
                )
              ) {
                index++
              }
              onChange({
                ...expression,
                parameters: [
                  ...expression.parameters,
                  { kind: "local", parameter_id: `parameter_${index}` },
                ],
              })
            }}
            type="button"
          >
            {t("add")}
          </button>
          {child(
            "body",
            expression.body,
            (body) => onChange({ ...expression, body }),
            [
              ...locals.filter(
                (local) =>
                  !expression.parameters.some(
                    (parameter) =>
                      parameter.parameter_id === local.parameter_id,
                  ),
              ),
              ...expression.parameters,
            ],
          )}
        </>
      )
      break
    default:
      fields = null
  }
  return (
    <fieldset
      className="flex flex-col gap-2 rounded border p-3"
      data-expression-kind={expression.kind}
    >
      <label>
        {t("kind")}
        <select
          name={`${path}.kind`}
          onChange={(event) => {
            const kind = expressionKinds.find(
              (value) => value === event.target.value,
            )
            if (kind) {
              onChange(newExpression(kind, seed, slots, locals))
            }
          }}
          value={expression.kind}
        >
          {expressionKinds.map((kind) => (
            <option
              disabled={
                (kind === "literal_slot" && slots.length === 0) ||
                (kind === "symbol" && symbols.length === 0) ||
                (kind === "local" && locals.length === 0)
              }
              key={kind}
              value={kind}
            >
              {kind}
            </option>
          ))}
        </select>
      </label>
      {fields}
    </fieldset>
  )
}
