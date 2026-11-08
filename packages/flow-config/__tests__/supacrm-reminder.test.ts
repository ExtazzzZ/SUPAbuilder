import { expect, it } from "vitest"
import {
  assertDraftWrappers,
  configureSupacrmReminder,
  createSupacrmReminderNode,
  publishFlowSchema,
  supacrmReminderSchema,
} from "../src"

it("принимает подтверждение клиента как событие напоминания", () => {
  const node = createSupacrmReminderNode({ dataProps: { isStartNode: true } })
  expect(
    supacrmReminderSchema.safeParse({
      ...node.data.details.supacrmReminder,
      anchor: "customer_confirmed",
    }).success,
  ).toBe(true)
})

it("publishes an event reminder with two stable outputs and no money authority", () => {
  const node = createSupacrmReminderNode({ dataProps: { isStartNode: true } })
  expect(
    publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
  ).toBe(true)
  expect(node.data.details.quickReplies).toHaveLength(2)
  const changed = configureSupacrmReminder(node, {
    ...node.data.details.supacrmReminder,
    delaySeconds: 60,
  })
  expect(changed.data.details.quickReplies).toEqual(
    node.data.details.quickReplies,
  )
  expect(
    supacrmReminderSchema.safeParse({
      ...node.data.details.supacrmReminder,
      paid: true,
    }).success,
  ).toBe(false)
  changed.data.details.beforeStep.channel = "telegram"
  expect(() => assertDraftWrappers([changed])).toThrow()
})
