import { createSupacrmEmailNode } from "@chatbotx.io/flow-config"
import { expect, test, vi } from "vitest"
import { createReceiptEmailTemplateDraftMutation } from "../src/features/flows/supacrm-form/template-draft"

const implementation = { createReceiptEmailTemplateDraftMutation }

test("adoption drains old saves, checks current graph, applies only returned node and releases lock", async () => {
  expect(implementation).toHaveProperty(
    "createReceiptEmailTemplateDraftMutation",
  )
  const events: string[] = []
  const nodes = [
    createSupacrmEmailNode({ nodeProps: { id: "101" } }),
    createSupacrmEmailNode({ nodeProps: { id: "102" } }),
  ]
  const updated = { ...nodes[0], data: { ...nodes[0].data, name: "Accepted" } }
  const mutate = vi.fn((input: unknown) => {
    events.push("mutate")
    expect(input).toMatchObject({
      expectedNode: nodes[0],
      expectedGraph: { nodes, edges: [] },
    })
    return Promise.resolve({
      status: "ready" as const,
      node: updated,
      changes: [],
    })
  })
  const apply = vi.fn(() => {
    events.push("apply")
  })
  const deps = {
    isMutatingRef: { current: false },
    setMutating: vi.fn(),
    cancelAutosave: () => {
      events.push("cancel")
    },
    waitForSaves: () =>
      Promise.resolve().then(() => {
        events.push("drain")
      }),
    getGraph: () => ({ nodes, edges: [] }),
    mutate,
    apply,
  }
  const run = implementation.createReceiptEmailTemplateDraftMutation(deps)
  await run({ nodeId: "101", action: "adopt" })
  expect(events).toEqual(["cancel", "drain", "mutate", "apply"])
  expect(apply).toHaveBeenCalledWith(updated)
  expect(deps.isMutatingRef.current).toBe(false)
})
test("preview never applies, and stale rejection leaves local graph intact and unlocks", async () => {
  expect(implementation).toHaveProperty(
    "createReceiptEmailTemplateDraftMutation",
  )
  const apply = vi.fn()
  const deps = {
    isMutatingRef: { current: false },
    setMutating: vi.fn(),
    cancelAutosave: vi.fn(),
    waitForSaves: () => Promise.resolve(),
    getGraph: () => ({ nodes: [{ id: "101" }], edges: [] }),
    mutate: vi
      .fn()
      .mockResolvedValue({ status: "ready", node: { id: "101" }, changes: [] }),
    apply,
  }
  const run = implementation.createReceiptEmailTemplateDraftMutation(deps)
  await run({ nodeId: "101", action: "preview" })
  expect(apply).not.toHaveBeenCalled()
  deps.mutate.mockRejectedValueOnce(new Error("stale"))
  await expect(run({ nodeId: "101", action: "adopt" })).rejects.toThrow("stale")
  expect(apply).not.toHaveBeenCalled()
  expect(deps.isMutatingRef.current).toBe(false)
})
