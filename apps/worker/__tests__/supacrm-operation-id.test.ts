import { describe, expect, test } from "vitest"
import {
  createChatOperationId,
  createFlowOperationId,
} from "../src/chat/operation-id"

describe("SUPAcrm operation identity", () => {
  test("queue retry reuses identity; new job and reused ID differ", () => {
    const id = createChatOperationId({ id: "1", timestamp: 10 })
    expect(createChatOperationId({ id: "1", timestamp: 10 })).toBe(id)
    expect(createChatOperationId({ id: "2", timestamp: 10 })).not.toBe(id)
    expect(createChatOperationId({ id: "1", timestamp: 11 })).not.toBe(id)
    expect(() => createChatOperationId({ timestamp: 10 })).toThrow("durable")
  })
  test("parent retries match even with fresh chat jobs; loops and contacts differ", () => {
    const props = {
      flowExecutionKey: "run-1",
      conversation: { id: "c1" },
      flowVersion: { id: "v1" },
      step: { id: "s1" },
      nodeVisits: { b: 1, a: 2 },
    }
    const id = createFlowOperationId(props)
    expect(
      createFlowOperationId({ ...props, nodeVisits: { a: 2, b: 1 } }),
    ).toBe(id)
    expect(
      createFlowOperationId({ ...props, nodeVisits: { a: 3, b: 1 } }),
    ).not.toBe(id)
    expect(
      createFlowOperationId({ ...props, conversation: { id: "c2" } }),
    ).not.toBe(id)
  })
})
