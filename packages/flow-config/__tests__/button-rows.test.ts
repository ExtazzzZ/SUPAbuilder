import { describe, expect, test } from "vitest"
import {
  buttonStepDefaultFn,
  buttonStepSchema,
  chooseChannelStepDefaultFn,
  flowExportedFlowSchema,
  flowVersionSchema,
  groupButtonRows,
  mergeButtonGroups,
  publishFlowSchema,
  resolveSendTextLengthLimits,
  sendMessageNodeDefaultFn,
  sendTextStepDefaultFn,
  setButtonRowPlacement,
} from "../src"

const button = (label: string, row?: number) => ({
  ...buttonStepDefaultFn({ label }),
  ...(row === undefined ? {} : { row }),
})

describe("строки кнопок", () => {
  test("объединяет только соседние явные row, сохраняя старые кнопки и три кнопки в строке", () => {
    const buttons = [
      button("1"),
      button("2", 0),
      button("3", 0),
      button("4"),
      button("5", 0),
      button("6", 0),
      button("7", 0),
    ]
    expect(
      groupButtonRows(buttons).map((row) => row.map((item) => item.label)),
    ).toEqual([["1"], ["2", "3"], ["4"], ["5", "6", "7"]])
  })

  test("редактор создаёт пару и отдельную кнопку, затем разделяет пару без изменения действий", () => {
    const buttons = [button("1"), button("2"), button("Назад")]
    const paired = setButtonRowPlacement(buttons, 1, true)
    expect(paired.map((item) => item.row)).toEqual([0, 0, 1])
    expect(setButtonRowPlacement(paired, 2, true)).toEqual(paired)
    const separated = setButtonRowPlacement(paired, 1, false)
    expect(separated.map((item) => item.row)).toEqual([0, 1, 2])
    expect(separated.map(({ row: _, ...rest }) => rest)).toEqual(buttons)
  })

  test("проверяет row и сохраняет его в черновике, публикации и импорте", () => {
    const buttons = [button("1", 0), button("2", 0), button("Назад", 1)]
    const node = sendMessageNodeDefaultFn({
      labelVersion: 1,
      detailProps: {
        beforeStep: chooseChannelStepDefaultFn({ channel: "api" }),
        quickReplies: buttons,
        steps: [],
      },
    })
    const graph = { nodes: [node], edges: [] }
    const published = publishFlowSchema.parse(graph)
    const imported = flowExportedFlowSchema.parse({
      ...graph,
      name: "Кнопки",
      active: false,
      enableInInbox: true,
      startNodeId: node.id,
    })
    for (const parsed of [
      flowVersionSchema.parse(node),
      published.nodes[0],
      imported.nodes[0],
    ]) {
      expect(parsed?.data.details).toMatchObject({ quickReplies: buttons })
    }
    expect(buttonStepSchema.parse(button("Старая"))).not.toHaveProperty("row")
    for (const row of [-1, 100, 0.5, "0", null]) {
      expect(buttonStepSchema.safeParse({ ...buttons[0], row }).success).toBe(
        false,
      )
    }
  })
})

test("не склеивает граничные строки кнопок шага и быстрых ответов", () => {
  const merged = mergeButtonGroups(
    [button("1", 0), button("2", 0)],
    [button("3", 0), button("4", 0), button("Старая")],
  )
  expect(merged.map((item) => item.row)).toEqual([0, 0, 1, 1, undefined])
  expect(groupButtonRows(merged).map((row) => row.length)).toEqual([2, 2, 1])
})

test("API сохраняет подписи до 80 символов, остальные каналы сохраняют ограничение 20", () => {
  const label = "Я".repeat(80)
  const makeGraph = (channel: string) => ({
    nodes: [
      sendMessageNodeDefaultFn({
        labelVersion: 1,
        detailProps: {
          beforeStep: chooseChannelStepDefaultFn({ channel }),
          steps: [
            {
              ...sendTextStepDefaultFn({ text: "Меню" }),
              buttons: [button(label, 0)],
            },
          ],
          quickReplies: [button(label, 1)],
        },
      }),
    ],
    edges: [],
  })
  for (const channel of ["api", "omnichannel"]) {
    expect(publishFlowSchema.safeParse(makeGraph(channel)).success).toBe(true)
    expect(resolveSendTextLengthLimits({ channel }).buttonLabel).toBe(80)
  }
  for (const channel of ["telegram", "whatsapp", "messenger", "instagram"]) {
    const graph = makeGraph(channel)
    expect(flowVersionSchema.safeParse(graph.nodes[0]).success).toBe(true)
    const result = publishFlowSchema.safeParse(graph)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        "nodes",
        0,
        "data",
        "details",
        "quickReplies",
        0,
        "label",
      ])
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        "nodes",
        0,
        "data",
        "details",
        "steps",
        0,
        "buttons",
        0,
        "label",
      ])
    }
  }
  expect(buttonStepSchema.safeParse(button("😀".repeat(80))).success).toBe(true)
  expect(buttonStepSchema.safeParse(button("Я".repeat(81))).success).toBe(false)
})
