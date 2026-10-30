import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type { TemplateResourceKind } from "@chatbotx.io/database/partials"
import { sql } from "drizzle-orm"
import { ChatbotXException } from "../errors"

/**
 * The per-resource lock protocol shared by every writer of a
 * template-installed resource: a local editor (via `assertEditable`), a sync,
 * a restore and the uninstall. All of them serialize on
 * `pg_advisory_xact_lock(hashtextextended('tpl-res:' || kind || ':' || id, 0))`
 * and take their WHOLE key set in ONE sorted pass, `(kind, resourceId)`, so
 * lock order is global and no wait cycle can form.
 *
 * A key is never acquired after another one in the same transaction. A
 * caller that discovers it needs a key it does not hold (a referenced parent
 * resolved differently once the locks were taken) gets a
 * `TemplateLockSetGrownError`; `withTemplateLockedTransaction` rolls back and
 * retries with the union taken up front, at most `MAX_ATTEMPTS` times.
 */

export type TemplateLockKey = {
  kind: TemplateResourceKind
  resourceId: string
}

const MAX_ATTEMPTS = 3

const keyText = (key: TemplateLockKey): string =>
  `tpl-res:${key.kind}:${key.resourceId}`

const compareKeys = (a: TemplateLockKey, b: TemplateLockKey): number => {
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1
  }
  if (a.resourceId === b.resourceId) {
    return 0
  }
  return a.resourceId < b.resourceId ? -1 : 1
}

/** De-duplicated and sorted by `(kind, resourceId)`: the one global lock order. */
export const sortTemplateLockKeys = (
  keys: readonly TemplateLockKey[],
): TemplateLockKey[] => {
  const unique = new Map(keys.map((key) => [keyText(key), key] as const))
  return [...unique.values()].sort(compareKeys)
}

/** The transaction needs a lock it does not hold yet; roll back and retry with `keys` taken first. */
export class TemplateLockSetGrownError extends Error {
  readonly keys: readonly TemplateLockKey[]
  constructor(keys: readonly TemplateLockKey[]) {
    super("The template lock set grew while the transaction was running")
    this.name = "TemplateLockSetGrownError"
    this.keys = keys
  }
}

export const templateLockContentionException = () =>
  new ChatbotXException(
    "The resource is being changed by another operation; try again",
    "templateLockContention",
    409,
  )

/** What each open transaction already holds, so a repeat call is a no-op. */
const heldByTransaction = new WeakMap<object, Map<string, TemplateLockKey>>()

/**
 * Takes the `tpl-res:` locks for `keys`, sorted, in `tx`. The first call in a
 * transaction acquires; a later call whose keys are all held is a no-op; a
 * later call that needs a new key throws `TemplateLockSetGrownError` (the
 * caller's `withTemplateLockedTransaction` retries with the union) instead of
 * taking it late, because a lower-sorted key acquired after a higher one is
 * how a deadlock cycle forms.
 */
export const acquireTemplateResourceLocks = async (
  tx: DatabaseClient,
  keys: readonly TemplateLockKey[],
): Promise<void> => {
  const wanted = sortTemplateLockKeys(keys)
  const held = heldByTransaction.get(tx)
  if (held) {
    const missing = wanted.filter((key) => !held.has(keyText(key)))
    if (missing.length === 0) {
      return
    }
    throw new TemplateLockSetGrownError(
      sortTemplateLockKeys([...held.values(), ...missing]),
    )
  }
  const acquired = new Map<string, TemplateLockKey>()
  heldByTransaction.set(tx, acquired)
  for (const key of wanted) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${keyText(key)}, 0))`,
    )
    acquired.set(keyText(key), key)
  }
}

/**
 * Runs `callback` in a transaction, retrying (rolled back, with the grown key
 * set acquired first) when a guard inside discovers it needs more locks.
 * `initialKeys` are taken before `callback` runs on every attempt.
 */
export const withTemplateLockedTransaction = async <T>(
  callback: (tx: DatabaseClient) => Promise<T>,
  options: {
    initialKeys?: readonly TemplateLockKey[]
    /**
     * Runs first on every attempt, BEFORE any `tpl-res:` lock: the coarser
     * locks (the install-request lock) always come before the per-resource
     * ones, so every writer orders its locks identically.
     */
    prepare?: (tx: DatabaseClient) => Promise<void>
    database?: Pick<typeof db, "transaction">
  } = {},
): Promise<T> => {
  const database = options.database ?? db
  let keys = sortTemplateLockKeys(options.initialKeys ?? [])
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await database.transaction(async (tx) => {
        await options.prepare?.(tx)
        if (keys.length > 0) {
          await acquireTemplateResourceLocks(tx, keys)
        }
        return await callback(tx)
      })
    } catch (error) {
      if (!(error instanceof TemplateLockSetGrownError)) {
        throw error
      }
      keys = sortTemplateLockKeys([...keys, ...error.keys])
    }
  }
  throw templateLockContentionException()
}
