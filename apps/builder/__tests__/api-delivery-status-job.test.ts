import { expect, test } from "vitest"
import { deliveryStatusJobOptions } from "../src/features/integration-api/lib/delivery-status-job"

const STATUS_JOB_ID = /^api-status-[a-f0-9]{64}$/

const input = {
  messageId: "crm:job",
  status: "delivered",
  timestamp: "2026-11-06T00:00:00+00:00",
}
test("stable scope-aware BullMQ-safe status identity and retained retry policy", async () => {
  const opts = await deliveryStatusJobOptions("inbox", input)
  expect(await deliveryStatusJobOptions("inbox", { ...input })).toEqual(opts)
  expect(opts.jobId).toMatch(STATUS_JOB_ID)
  expect(opts.deduplication).toEqual({ id: opts.jobId, ttl: 604_800_000 })
  expect(opts.attempts).toBe(4)
  expect(opts.backoff).toEqual({ type: "exponential", delay: 1000 })
  expect(opts.removeOnComplete).toEqual({ age: 86_400 })
  expect(opts.removeOnFail).toEqual({ age: 604_800 })
  for (const [inbox, patch] of [
    ["other", {}],
    ["inbox", { messageId: "other" }],
    ["inbox", { status: "failed" }],
    ["inbox", { status: "read" }],
    ["inbox", { timestamp: "2026-11-06T00:00:01Z" }],
  ] as const) {
    expect(
      (await deliveryStatusJobOptions(inbox, { ...input, ...patch })).jobId,
    ).not.toBe(opts.jobId)
  }
})
