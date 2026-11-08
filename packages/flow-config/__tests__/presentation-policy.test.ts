import { describe, expect, it } from "vitest"
import { publishFlowSchema, sendMessageNodeDefaultFn } from "../src/index"

describe("Режим обновления окна SUPAcrm", () => {
  it.each([
    "send_new",
    "edit_previous",
  ] as const)("сохраняет %s при публикации", (updateMode) => {
    const node = sendMessageNodeDefaultFn({})
    node.data.details.presentation = { updateMode }
    const parsed = publishFlowSchema.parse({ nodes: [node], edges: [] })
    expect(parsed.nodes[0]?.data.details).toMatchObject({
      presentation: { updateMode },
    })
  })
  it("не принимает ошибку в имени режима", () => {
    const node = sendMessageNodeDefaultFn({})
    Object.assign(node.data.details, { presentation: { updateMode: "edit" } })
    expect(
      publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
    ).toBe(false)
  })
})
