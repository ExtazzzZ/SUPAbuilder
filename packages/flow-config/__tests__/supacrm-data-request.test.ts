import { expect, it } from "vitest"
import {
  assertDraftWrappers,
  configureSupacrmDataRequest,
  createSupacrmDataRequestNode,
  publishFlowSchema,
  sendMessageNodeSchema,
  supacrmDataRequestSchema,
} from "../src"

it("publishes typed data capture with three stable opaque outputs", () => {
  const node = createSupacrmDataRequestNode({
    dataProps: { isStartNode: true },
  })
  expect(
    publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
  ).toBe(true)
  expect(node.data.details.quickReplies).toHaveLength(3)
  const changed = configureSupacrmDataRequest(node, {
    ...node.data.details.supacrmDataRequest,
    valueType: "email",
    variableKey: "input.email",
  })
  expect(changed.data.details.quickReplies).toEqual(
    node.data.details.quickReplies,
  )
  changed.data.details.steps[0].text = "forged"
  expect(() => assertDraftWrappers([changed])).toThrow()
})
it("rejects financial targets, arbitrary validators, extra ports and mixed wrappers", () => {
  const node = createSupacrmDataRequestNode({})
  const settings = node.data.details.supacrmDataRequest
  expect(
    supacrmDataRequestSchema.safeParse({ ...settings, variableKey: "balance" })
      .success,
  ).toBe(false)
  expect(
    supacrmDataRequestSchema.safeParse({ ...settings, validator: "javascript" })
      .success,
  ).toBe(false)
  node.data.details.quickReplies.push(node.data.details.quickReplies[0])
  expect(sendMessageNodeSchema.safeParse(node).success).toBe(false)
})
