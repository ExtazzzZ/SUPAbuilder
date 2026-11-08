import { expect, it } from "vitest"
import {
  assertDraftWrappers,
  configureSupacrmOperator,
  createSupacrmOperatorNode,
  publishFlowSchema,
  sendMessageNodeSchema,
} from "../src"

it("publishes a strict native operator node and keeps opaque handles on edit", () => {
  const node = createSupacrmOperatorNode({ dataProps: { isStartNode: true } })
  expect(sendMessageNodeSchema.safeParse(node).success).toBe(true)
  expect(
    publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
  ).toBe(true)
  const changed = configureSupacrmOperator(node, {
    ...node.data.details.supacrmOperator,
    reason: "Поддержка",
  })
  expect(changed.data.details.quickReplies).toEqual(
    node.data.details.quickReplies,
  )
  expect(changed.data.details.steps[0].id).toBe(node.data.details.steps[0].id)
  changed.data.details.steps[0].text = "changed"
  expect(sendMessageNodeSchema.safeParse(changed).success).toBe(false)
  expect(() => assertDraftWrappers([changed])).toThrow()
})
it("rejects mixed wrappers, duplicate ports and channel drift", () => {
  for (const kind of ["mixed", "ports", "channel"]) {
    const node = createSupacrmOperatorNode({})
    if (kind === "mixed") {
      node.data.details.supacrmProduct = {
        catalogItemId: "123e4567-e89b-42d3-a456-426614174000",
      } as never
    }
    if (kind === "ports") {
      node.data.details.quickReplies[1].id =
        node.data.details.quickReplies[0].id
    }
    if (kind === "channel") {
      node.data.details.beforeStep.channel = "telegram"
    }
    expect(sendMessageNodeSchema.safeParse(node).success).toBe(false)
  }
})
