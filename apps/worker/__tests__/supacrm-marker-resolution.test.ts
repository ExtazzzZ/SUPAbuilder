import {
  createSupacrmDataRequestNode,
  createSupacrmOperatorNode,
} from "@chatbotx.io/flow-config"
import { expect, it, vi } from "vitest"

const resolve = vi.hoisted(() =>
  vi.fn(async (_id, step) => ({ ...step, text: "changed" })),
)
vi.mock("@chatbotx.io/variables", () => ({
  resolveContactVariablesDeep: resolve,
}))

import { resolveAuthoredChannelStep } from "../src/chat/resolve-authored-channel-step"

it("passes structured CRM commands literally, including spintax and variable syntax", async () => {
  for (const node of [
    createSupacrmOperatorNode({}),
    createSupacrmDataRequestNode({}),
  ]) {
    const step = {
      ...node.data.details.steps[0],
      text: node.data.details.steps[0].text.replace(".", "|{{field}}."),
    }
    expect(
      await resolveAuthoredChannelStep("1", step, "api", {} as never),
    ).toBe(step)
  }
  expect(resolve).not.toHaveBeenCalled()
  expect(
    await resolveAuthoredChannelStep(
      "1",
      { stepType: "sendText", text: "Hello" },
      "api",
      {} as never,
    ),
  ).toEqual({ stepType: "sendText", text: "changed" })
})
