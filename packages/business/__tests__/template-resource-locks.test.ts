// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/database/client", () => ({ db: {} }))

const {
  TemplateLockSetGrownError,
  acquireTemplateResourceLocks,
  sortTemplateLockKeys,
  withTemplateLockedTransaction,
} = await import("../src/template/template-resource-locks")

type Key = { kind: "flow" | "reflink" | "trigger"; resourceId: string }

/** A transaction whose `execute` calls are inspected for the lock keys. */
const makeTx = () => ({
  execute: vi.fn(async (_statement: { queryChunks: unknown[] }) => undefined),
})

const lockedKeysOf = (tx: ReturnType<typeof makeTx>): string[] => {
  const texts: string[] = []
  for (const [statement] of tx.execute.mock.calls) {
    const chunks = (statement as { queryChunks: unknown[] }).queryChunks
    for (const chunk of chunks) {
      const value = (chunk as { value?: unknown[] }).value
      if (Array.isArray(value)) {
        for (const part of value) {
          if (typeof part === "string" && part.startsWith("tpl-res:")) {
            texts.push(part)
          }
        }
      }
      if (typeof chunk === "string" && chunk.startsWith("tpl-res:")) {
        texts.push(chunk)
      }
    }
  }
  return texts
}

describe("sortTemplateLockKeys", () => {
  test("orders by kind, then resource id, and drops duplicates", () => {
    const keys: Key[] = [
      { kind: "trigger", resourceId: "a" },
      { kind: "flow", resourceId: "z" },
      { kind: "flow", resourceId: "b" },
      { kind: "flow", resourceId: "b" },
      { kind: "reflink", resourceId: "m" },
    ]

    expect(sortTemplateLockKeys(keys)).toEqual([
      { kind: "flow", resourceId: "b" },
      { kind: "flow", resourceId: "z" },
      { kind: "reflink", resourceId: "m" },
      { kind: "trigger", resourceId: "a" },
    ])
  })

  test("two writers with the same keys in any order lock in the same order", () => {
    const a: Key[] = [
      { kind: "reflink", resourceId: "r1" },
      { kind: "flow", resourceId: "f1" },
    ]
    const b = [...a].reverse()
    expect(sortTemplateLockKeys(a)).toEqual(sortTemplateLockKeys(b))
  })
})

describe("acquireTemplateResourceLocks", () => {
  test("issues one advisory lock per key, in sorted order", async () => {
    const tx = makeTx()
    await acquireTemplateResourceLocks(tx as never, [
      { kind: "trigger", resourceId: "t1" },
      { kind: "flow", resourceId: "f2" },
      { kind: "flow", resourceId: "f1" },
    ])

    expect(tx.execute).toHaveBeenCalledTimes(3)
    expect(lockedKeysOf(tx)).toEqual([
      "tpl-res:flow:f1",
      "tpl-res:flow:f2",
      "tpl-res:trigger:t1",
    ])
  })

  test("a repeat call for keys already held takes nothing", async () => {
    const tx = makeTx()
    await acquireTemplateResourceLocks(tx as never, [
      { kind: "flow", resourceId: "f1" },
      { kind: "reflink", resourceId: "r1" },
    ])
    await acquireTemplateResourceLocks(tx as never, [
      { kind: "flow", resourceId: "f1" },
    ])

    expect(tx.execute).toHaveBeenCalledTimes(2)
  })

  test("a later key is never taken late: the caller is told the set grew", async () => {
    const tx = makeTx()
    await acquireTemplateResourceLocks(tx as never, [
      { kind: "reflink", resourceId: "r1" },
    ])

    const attempt = acquireTemplateResourceLocks(tx as never, [
      { kind: "flow", resourceId: "f1" },
    ])

    await expect(attempt).rejects.toBeInstanceOf(TemplateLockSetGrownError)
    await expect(attempt).rejects.toMatchObject({
      keys: [
        { kind: "flow", resourceId: "f1" },
        { kind: "reflink", resourceId: "r1" },
      ],
    })
    // Only the first call locked anything.
    expect(tx.execute).toHaveBeenCalledTimes(1)
  })
})

describe("withTemplateLockedTransaction", () => {
  const makeDatabase = () => {
    const transactions: ReturnType<typeof makeTx>[] = []
    return {
      transactions,
      database: {
        transaction: async (run: (tx: never) => Promise<unknown>) => {
          const tx = makeTx()
          transactions.push(tx)
          return await run(tx as never)
        },
      } as never,
    }
  }

  test("prepare runs before any resource lock, on every attempt", async () => {
    const { database, transactions } = makeDatabase()
    const order: string[] = []

    await withTemplateLockedTransaction(
      async () => {
        await Promise.resolve()
        order.push("body")
      },
      {
        database,
        initialKeys: [{ kind: "flow", resourceId: "f1" }],
        prepare: async (tx) => {
          await Promise.resolve()
          order.push(
            `prepare:${(tx as never as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls.length}`,
          )
        },
      },
    )

    expect(order).toEqual(["prepare:0", "body"])
    expect(transactions).toHaveLength(1)
  })

  test("retries with the grown set acquired up front, then succeeds", async () => {
    const { database, transactions } = makeDatabase()
    let attempts = 0

    const result = await withTemplateLockedTransaction(
      async (tx) => {
        attempts++
        // First attempt discovers a parent it did not lock.
        await acquireTemplateResourceLocks(tx, [
          { kind: "reflink", resourceId: "r1" },
        ])
        await acquireTemplateResourceLocks(tx, [
          { kind: "flow", resourceId: "f1" },
        ])
        return "done"
      },
      { database },
    )

    expect(result).toBe("done")
    expect(attempts).toBe(2)
    // The retry took the whole union, sorted, in one pass.
    expect(lockedKeysOf(transactions[1])).toEqual([
      "tpl-res:flow:f1",
      "tpl-res:reflink:r1",
    ])
  })

  test("gives up after three attempts with a transient conflict", async () => {
    const { database } = makeDatabase()
    let attempts = 0

    await expect(
      withTemplateLockedTransaction(
        async () => {
          await Promise.resolve()
          attempts++
          // The set keeps growing: a new key every time.
          throw new TemplateLockSetGrownError([
            { kind: "flow", resourceId: `f${attempts}` },
          ])
        },
        { database },
      ),
    ).rejects.toMatchObject({ code: "templateLockContention" })
    expect(attempts).toBe(3)
  })

  test("any other error is not retried", async () => {
    const { database } = makeDatabase()
    let attempts = 0

    await expect(
      withTemplateLockedTransaction(
        async () => {
          await Promise.resolve()
          attempts++
          throw new Error("boom")
        },
        { database },
      ),
    ).rejects.toThrow("boom")
    expect(attempts).toBe(1)
  })
})
