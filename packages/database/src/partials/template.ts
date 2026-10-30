import { z } from "zod"

/**
 * Every resource category a Template can bundle. Kept as a single source of
 * truth so the business-layer adapter registry can `satisfies
 * Record<TemplateCategory, ResourceAdapter>` and fail to compile if a
 * category is ever added here without a matching adapter.
 */
/**
 * Manifest-only categories (`customFields`/`tags`/`productCategories`)
 * resolve in Phase R before any adapter runs and never get their own
 * `ResourceAdapter` — kept as a separate enum so
 * `templateResourceCategories` below can `Exclude` them and let the adapter
 * registry `satisfies Record<TemplateResourceCategory, ResourceAdapter>` with
 * no `Partial`, making a category added here without a matching adapter a
 * compile error again (see `adapters/registry.ts`).
 */
export const templateManifestOnlyCategories = z.enum([
  "customFields",
  "tags",
  "productCategories",
])
export type TemplateManifestOnlyCategory = z.infer<
  typeof templateManifestOnlyCategories
>

export const templateResourceCategories = z.enum([
  "flows",
  "products",
  "aiFunctions",
  "aiAgents",
  "calendars",
  "webchats",
  "keywords",
  "entryPointLinks",
  "triggers",
  "fbCommentAutomations",
  "settings",
  "sequences",
  "aiMcpServers",
  "aiFiles",
  "questionnaires",
  "couponTopics",
  "pipelines",
])
export type TemplateResourceCategory = z.infer<
  typeof templateResourceCategories
>

export const templateCategories = z.enum([
  ...templateResourceCategories.options,
  ...templateManifestOnlyCategories.options,
])
export type TemplateCategory = z.infer<typeof templateCategories>

export const templateInstallationStatuses = z.enum([
  "pending",
  "installing",
  "completed",
  "partial",
  "failed",
  "uninstalled",
])
export type TemplateInstallationStatus = z.infer<
  typeof templateInstallationStatuses
>

/**
 * Who a row acts as when nobody is clicking: a workspace member (whose id can
 * later be nulled by a user delete, which must read as lost access) or a
 * workspace API token (no member row, by design).
 */
export const templateActorKinds = z.enum(["member", "apiToken"])
export type TemplateActorKind = z.infer<typeof templateActorKinds>

/** Who asked for an uninstall. */
export const templateUninstallRequesters = z.enum(["publisher", "installer"])
export type TemplateUninstallRequester = z.infer<
  typeof templateUninstallRequesters
>

/**
 * What an uninstall did with the copies the installation created, by count.
 * Stored as jsonb: rows written before `keptHasDependents` existed lack the
 * key, so always read through `parseTemplateUninstallCounts` (default 0).
 */
export const templateUninstallCountsSchema = z.object({
  /** Unmodified copies that were deleted. */
  deleted: z.number().int().nonnegative().default(0),
  /** Copies the installer edited (or that cannot be told apart from edited): kept. */
  keptModified: z.number().int().nonnegative().default(0),
  /** Tags, fields, folders and the like, which may be in use elsewhere: kept. */
  keptShared: z.number().int().nonnegative().default(0),
  /** Kinds an uninstall does not delete yet: kept, no longer locked. */
  keptByPolicy: z.number().int().nonnegative().default(0),
  /** Copies something else still depends on (e.g. a flow another resource references): kept. */
  keptHasDependents: z.number().int().nonnegative().default(0),
})
export type TemplateUninstallCounts = z.output<
  typeof templateUninstallCountsSchema
>

/** Reads stored (possibly pre-`keptHasDependents`) counts; `null` stays `null`. */
export const parseTemplateUninstallCounts = (
  value: unknown,
): TemplateUninstallCounts | null => {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = templateUninstallCountsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Why a sync ran: a publisher save, the installer's request, or a reinstall. */
export const templateSyncTriggers = z.enum([
  "autoUpdate",
  "manual",
  "reinstall",
])
export type TemplateSyncTrigger = z.infer<typeof templateSyncTriggers>

export const templateSyncStatuses = z.enum([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
  "cancelled",
])
export type TemplateSyncStatus = z.infer<typeof templateSyncStatuses>

/**
 * `lockAll` / `lockedIds` are the per-item "View only" choice: a locked item
 * installs as a read-only copy. Absent means every item stays editable.
 */
export const templateResourceSelectionSchema = z.union([
  z.object({ mode: z.literal("all"), lockAll: z.boolean().optional() }),
  z.object({
    mode: z.literal("ids"),
    ids: z.array(z.string()),
    lockedIds: z.array(z.string()).optional(),
  }),
])
export type TemplateResourceSelection = z.infer<
  typeof templateResourceSelectionSchema
>

export const templateSelectionSchema = z.partialRecord(
  templateCategories,
  templateResourceSelectionSchema,
)
export type TemplateSelection = z.infer<typeof templateSelectionSchema>

// A partial record: a payload written before a category existed has no key for
// it, and `z.record(enum)` would reject it for the missing keys.
export const templateCategoryCountsSchema = z.partialRecord(
  templateCategories,
  z.number().int().nonnegative(),
)
export type TemplateCategoryCounts = z.infer<
  typeof templateCategoryCountsSchema
>

export const templatePermissionsSchema = z.object({
  allowEdit: z.boolean().default(true),
  allowDelete: z.boolean().default(true),
})
export type TemplatePermissions = z.infer<typeof templatePermissionsSchema>

export const templateWarningSchema = z.object({
  category: templateCategories,
  entityKind: z.string(),
  path: z.string(),
  value: z.string(),
})
export type TemplateWarning = z.infer<typeof templateWarningSchema>

/**
 * Every `resourceKind` a template-installed copy can be tracked under. One
 * source of truth: the lock guards, the lock policy and the adapters are all
 * typed against it, so a misspelt kind is a compile error instead of a lock
 * that silently never matches. The DB column stays `text`.
 */
export const templateResourceKinds = z.enum([
  "flow",
  "aiAgent",
  "aiFunction",
  "calendar",
  "integrationWebchat",
  "automatedResponse",
  "reflink",
  "trigger",
  "fbCommentAutomation",
  "product",
  "savedReply",
  "botField",
  "customField",
  "tag",
  "folder",
  "pipeline",
  "productCategory",
  "sequence",
  "aiMcpServer",
  "aiFile",
  "questionnaire",
  "couponTopic",
])
export type TemplateResourceKind = z.infer<typeof templateResourceKinds>
