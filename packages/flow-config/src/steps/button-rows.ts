type RowButton = { row?: number }

/** Сохраняет порядок; старые кнопки без row всегда занимают отдельную строку. */
export function groupButtonRows<T extends RowButton>(
  buttons: readonly T[],
): T[][] {
  const rows: T[][] = []
  for (const button of buttons) {
    const previous = rows.at(-1)
    if (button.row !== undefined && previous?.at(-1)?.row === button.row) {
      previous.push(button)
    } else {
      rows.push([button])
    }
  }
  return rows
}

/** Меняет размещение одной кнопки, сохраняя остальные строки и действия. */
export function setButtonRowPlacement<T extends RowButton>(
  buttons: readonly T[],
  index: number,
  joinPrevious: boolean,
): T[] {
  const rows = groupButtonRows(buttons)
  const target = buttons[index]
  if (!target) {
    return [...buttons]
  }
  const sourceRow = rows.findIndex((row) => row.includes(target))
  const row = rows[sourceRow]
  if (!row) {
    return [...buttons]
  }
  const position = row.indexOf(target)
  if (joinPrevious) {
    const previousRow = position > 0 ? row : rows[sourceRow - 1]
    if (!previousRow || previousRow.length >= 2 || position > 0) {
      return [...buttons]
    }
    row.shift()
    previousRow.push(target)
    if (row.length === 0) {
      rows.splice(sourceRow, 1)
    }
  } else {
    rows.splice(
      sourceRow,
      1,
      ...[row.slice(0, position), [target], row.slice(position + 1)].filter(
        (part) => part.length > 0,
      ),
    )
  }
  return rows.flatMap((items, rowIndex) =>
    items.map((button) => ({ ...button, row: rowIndex })),
  )
}

/** Объединяет клавиатуры шага и быстрых ответов без склейки их пограничных строк. */
export function mergeButtonGroups<T extends RowButton>(
  ...groups: readonly T[][]
): T[] {
  return groups
    .flatMap((buttons) => groupButtonRows(buttons))
    .flatMap((row, index) =>
      row.map((button) =>
        button.row === undefined ? button : { ...button, row: index },
      ),
    )
}
