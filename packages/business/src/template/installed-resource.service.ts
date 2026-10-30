import type { DatabaseClient } from "@chatbotx.io/database/client"
import type { TemplateResourceKind } from "@chatbotx.io/database/partials"
import { templateInstalledResourceRepository } from "@chatbotx.io/database/repositories/template-installed-resource"
import { ChatbotXException } from "../errors"
import { TEMPLATE_LOCKED_CONTENT_KEYS } from "./lock-policy"
import {
  acquireTemplateResourceLocks,
  type TemplateLockKey,
} from "./template-resource-locks"

export const templateAllowDeleteViolationException = () =>
  new ChatbotXException(
    "This resource was installed from a template that disallows deletion",
    "templateAllowDeleteViolation",
  )

export const templateAllowEditViolationException = () =>
  new ChatbotXException(
    "This resource was installed from a template that disallows editing",
    "templateAllowEditViolation",
    403,
  )

type ResourceGuardInput = {
  workspaceId: string
  resourceKind: TemplateResourceKind
  resourceIds: readonly string[]
  tx?: DatabaseClient
  /** Installations whose locks do not count (the one being uninstalled). */
  excludeInstallationIds?: readonly string[]
}

/**
 * An edit guard always runs on a transaction: the `tpl-res:` advisory locks are
 * transaction-scoped, so a bare client would release them at statement end and
 * the guard would not serialize against a sync, restore or uninstall.
 */
type EditGuardInput = ResourceGuardInput & { tx: DatabaseClient }

/**
 * Enforces a template-installed copy's `allowDelete` for a category's delete
 * path with ONE statement (`findBlocking`). A reused row (`wasExisting`), a
 * detached copy, and a copy whose source template was deleted never lock
 * anything, and an id with no provenance row is treated as already gone, not
 * blocked.
 *
 * Called from every affected category's own delete path — this function only
 * decides yes/no, it never performs the delete itself.
 */
export const assertDeletable = async (
  input: ResourceGuardInput,
): Promise<void> => {
  const blocking = await templateInstalledResourceRepository.findBlocking(
    { ...input, permission: "allowDelete" },
    input.tx,
  )
  if (blocking.length > 0) {
    throw templateAllowDeleteViolationException()
  }
}

/**
 * Field-aware guard for content writes. `changedKeys` are the fields the write
 * touches and `lockedContentKeys` the kind's content fields
 * (`TEMPLATE_LOCKED_CONTENT_KEYS`): a write that touches none of them — a
 * toggle, a folder move, a runtime value — returns without a query, so the
 * per-keystroke autosave of a normal workspace costs nothing.
 *
 * Guards live in services, never in repositories: install adapters write
 * through repositories directly and must not be blocked by their own locks.
 */
export const assertEditable = async (
  input: EditGuardInput & {
    changedKeys: readonly string[]
    lockedContentKeys: readonly string[]
    /**
     * Resources the write payload references (a flow id, a category id...).
     * They are locked together with the resource, in the same sorted pass,
     * when they are template-installed.
     */
    referencedParents?: readonly TemplateLockKey[]
  },
): Promise<void> => {
  const touchesLockedContent = input.changedKeys.some((key) =>
    input.lockedContentKeys.includes(key),
  )
  if (!touchesLockedContent) {
    return
  }
  await lockInstalledResources(input.tx, input)
  const blocking = await templateInstalledResourceRepository.findBlocking(
    { ...input, permission: "allowEdit" },
    input.tx,
  )
  if (blocking.length > 0) {
    throw templateAllowEditViolationException()
  }
}

/**
 * Takes the `tpl-res:` locks of the resources (and referenced parents) that
 * have a live provenance row, in one sorted pass; a plain workspace pays only
 * the index-only lookup. Must be the FIRST step of the guarded transaction,
 * before any read or diff. Throws `TemplateLockSetGrownError` when this
 * transaction already holds a different set (see `withTemplateLockedTransaction`).
 */
const lockInstalledResources = async (
  tx: DatabaseClient,
  input: ResourceGuardInput & {
    referencedParents?: readonly TemplateLockKey[]
  },
): Promise<void> => {
  const keys: TemplateLockKey[] = []
  const own = await templateInstalledResourceRepository.findLiveIds(
    {
      workspaceId: input.workspaceId,
      resourceKind: input.resourceKind,
      resourceIds: input.resourceIds,
    },
    tx,
  )
  keys.push(
    ...own.map((resourceId) => ({ kind: input.resourceKind, resourceId })),
  )
  const parentsByKind = new Map<TemplateResourceKind, string[]>()
  for (const parent of input.referencedParents ?? []) {
    parentsByKind.set(parent.kind, [
      ...(parentsByKind.get(parent.kind) ?? []),
      parent.resourceId,
    ])
  }
  for (const [kind, resourceIds] of parentsByKind) {
    const live = await templateInstalledResourceRepository.findLiveIds(
      { workspaceId: input.workspaceId, resourceKind: kind, resourceIds },
      tx,
    )
    keys.push(...live.map((resourceId) => ({ kind, resourceId })))
  }
  if (keys.length > 0) {
    await acquireTemplateResourceLocks(tx, keys)
  }
}

/** The ids, among `resourceIds`, whose content is locked: one query per list page for the lock badges. */
export const listLockedIds = async (
  input: ResourceGuardInput,
): Promise<string[]> =>
  await templateInstalledResourceRepository.findBlocking(
    { ...input, permission: "allowEdit" },
    input.tx,
  )

/**
 * `assertEditable` with the kind's content keys looked up from
 * `TEMPLATE_LOCKED_CONTENT_KEYS`, so a service names the kind and the fields
 * its write touches and nothing else.
 */
export const assertResourceEditable = async (
  input: EditGuardInput & {
    changedKeys: readonly string[]
    referencedParents?: readonly TemplateLockKey[]
  },
): Promise<void> =>
  await assertEditable({
    ...input,
    lockedContentKeys: TEMPLATE_LOCKED_CONTENT_KEYS[input.resourceKind],
  })

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : nested,
  )

/**
 * The keys of `patch` whose value differs from the loaded `existing` row. A
 * full-form save submits every field, so guarding on the submitted keys would
 * block an installer-owned edit (a toggle, a domain list) on a locked item;
 * guarding on what actually changed does not. An absent key is not a change.
 */
export const changedKeysOf = (
  existing: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): string[] =>
  Object.keys(patch).filter(
    (key) =>
      patch[key] !== undefined &&
      stableJson(existing[key] ?? null) !== stableJson(patch[key] ?? null),
  )
