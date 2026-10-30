import type { DatabaseClient } from "@chatbotx.io/database/client"
import { isUniqueViolationError } from "@chatbotx.io/database/client"
import { type CopyNameStyle, insertWithFreeCopyName } from "../../lib/copy-name"

const MAX_RETRY_ATTEMPTS = 20

/**
 * Retries `insert` with a numeric suffix appended to whatever name field
 * `insert` closes over, on a unique-constraint violation. A pre-query
 * ("does this name already exist?") is TOCTOU-racy against a concurrent
 * insert from the same install transaction or another install running at
 * the same time — catching the real constraint violation is the only sound
 * check. Bounded by `MAX_RETRY_ATTEMPTS`; exhausting it warns and skips
 * rather than looping forever, since a template installing hundreds of
 * same-named resources is not a case worth optimizing for.
 *
 * Each attempt runs inside its own nested transaction (a Postgres SAVEPOINT
 * via Drizzle's `tx.transaction()`), because `insert` runs inside the
 * install's single outer transaction — in Postgres a 23505 poisons the whole
 * outer transaction (`25P02 in_failed_sql_transaction`) unless the failing
 * statement is isolated behind its own savepoint that can be rolled back on
 * its own. Without this, the first name collision anywhere in the install
 * rolled back the whole thing instead of suffixing.
 *
 * `constraint` narrows `isUniqueViolationError` to the one unique index this
 * retry is meant to catch, so an unrelated 23505 (a different constraint on
 * the same table) rethrows immediately instead of burning all
 * `MAX_RETRY_ATTEMPTS` and being misreported as a name collision.
 */
export const insertWithNameRetry = async <T>(
  tx: DatabaseClient,
  constraint: string,
  name: string,
  insert: (tx: DatabaseClient, candidateName: string) => Promise<T>,
  onGiveUp: (lastAttemptedName: string) => void,
): Promise<T | undefined> => {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const candidateName = attempt === 0 ? name : `${name} (${attempt + 1})`
    try {
      return await tx.transaction((savepointTx) =>
        insert(savepointTx, candidateName),
      )
    } catch (error) {
      if (!isUniqueViolationError(error, constraint)) {
        throw error
      }
      if (attempt === MAX_RETRY_ATTEMPTS - 1) {
        onGiveUp(candidateName)
        return
      }
    }
  }
  return
}

/**
 * Installs under the source's own name when it is free and otherwise under the
 * shared copy-name scheme (`<name> - Copy`, `<name> - Copy 2`, ...), the one
 * the rest of the product uses for duplicates. The unique index stays the
 * arbiter: each attempt runs in its own savepoint and only that constraint's
 * violation moves on, and the existing names are read once, only after the
 * plain name was refused. `onGiveUp` runs when every candidate is taken.
 */
export const insertWithCopyName = async <T>(input: {
  tx: DatabaseClient
  constraint: string
  name: string
  maxLength?: number
  style?: CopyNameStyle
  loadTakenNames: (tx: DatabaseClient) => Promise<readonly string[]>
  insert: (tx: DatabaseClient, name: string) => Promise<T>
  onGiveUp: (name: string) => void
}): Promise<T | undefined> => {
  const attempt = (name: string) =>
    input.tx.transaction((savepointTx) => input.insert(savepointTx, name))
  try {
    return await attempt(input.name)
  } catch (error) {
    if (!isUniqueViolationError(error, input.constraint)) {
      throw error
    }
  }
  const taken = new Set(await input.loadTakenNames(input.tx))
  const created = await insertWithFreeCopyName({
    base: input.name,
    taken,
    options: {
      style: input.style ?? "dash",
      maxLength: input.maxLength ?? 255,
    },
    constraint: input.constraint,
    insert: attempt,
  })
  if (created === undefined) {
    input.onGiveUp(input.name)
  }
  return created
}
