import type { CSSProperties } from "react"
import styles from "./supabuilder-wordmark.module.css"

// Stable brick geometry keeps the server and browser markup identical.
const letters = [
  ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  ["10000", "10000", "11110", "10001", "10001", "10001", "11110"],
  ["00000", "00000", "10001", "10001", "10001", "10001", "01111"],
  ["010", "000", "110", "010", "010", "010", "111"],
  ["110", "010", "010", "010", "010", "010", "001"],
  ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
  ["0000", "0000", "1011", "1100", "1000", "1000", "1000"],
]
let cursor = 12
const bricks = letters.flatMap((rows, letter) => {
  const left = cursor
  cursor += (rows[0].length + 1) * 8
  return rows.flatMap((row, y) =>
    Array.from(row).flatMap((pixel, x) =>
      pixel === "1"
        ? [
            {
              id: `${letter}-${y}-${x}`,
              x: left + x * 8,
              y: 24 + y * 8,
              letter,
              row: y,
              column: x,
            },
          ]
        : [],
    ),
  )
})
const width = cursor + 4

/** Однократная сборка названия из кубиков; без таймеров и внешних ассетов. */
export function SupaBuilderWordmark() {
  return (
    <svg
      aria-label="SUPAbuilder"
      className={styles.wordmark}
      role="img"
      viewBox={`0 0 ${width} 100`}
    >
      <title>SUPAbuilder</title>
      {bricks.map((brick) => (
        <g
          className={`${styles.brick} ${brick.letter < 4 ? styles.accent : ""}`}
          key={brick.id}
          style={
            {
              "--delay": `${brick.letter * 58 + brick.row * 12 + brick.column * 7}ms`,
              "--from-x": `${(((brick.column + brick.row) % 3) - 1) * 28}px`,
              "--from-y": `${-32 - (brick.row % 3) * 12}px`,
              "--from-rotation": `${(brick.letter + brick.column) % 2 ? 32 : -32}deg`,
            } as CSSProperties
          }
        >
          <rect height="6.8" rx="1.3" width="6.8" x={brick.x} y={brick.y} />
          <circle
            className={styles.stud}
            cx={brick.x + 3.4}
            cy={brick.y + 2.6}
            r="1.45"
          />
        </g>
      ))}
    </svg>
  )
}
