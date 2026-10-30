import type {
  FolderType,
  TemplateCategory,
} from "@chatbotx.io/database/partials"
import { rootFolderId } from "@chatbotx.io/database/partials"
import { folderModel } from "@chatbotx.io/database/schema"
import type {
  TemplateExport,
  TemplateFolderManifestEntry,
} from "@chatbotx.io/flow-config"
import { createId } from "@chatbotx.io/utils"
import { rebuildPipelineChildMappings } from "../../sync-pipeline-mapping"
import { folderTypeToCategory } from "../registry"
import type { TemplateInstallContext } from "../types"
import { resolveCustomFieldManifest } from "./custom-fields"
import { resolveFolderManifest } from "./folders"
import { resolveInboxManifest } from "./inboxes"
import { resolvePipelineManifest } from "./pipelines"
import { resolveProductCategoryManifest } from "./product-categories"
import { resolveTagManifest } from "./tags"

export type ManifestKey =
  | "folders"
  | "customFields"
  | "tags"
  | "productCategories"
  | "pipelines"
  | "inboxes"

/**
 * The permission category that gates creating each manifest. `null` means the
 * manifest is never gated (an inbox is never created at all). A pipeline is
 * created with the flow that needs it, so it needs the same permission as flows. Folders are gated per entry, by the
 * category that owns the folder's namespace.
 */
export const MANIFEST_GATE: Record<ManifestKey, TemplateCategory | null> = {
  folders: null,
  customFields: "customFields",
  tags: "tags",
  productCategories: "productCategories",
  pipelines: "flows",
  inboxes: null,
}

/** The `idMaps` kind each manifest fills; what `skipMapped` checks. */
const MANIFEST_ID_KIND: Record<ManifestKey, string> = {
  folders: "folder",
  customFields: "customField",
  tags: "tag",
  productCategories: "productCategory",
  pipelines: "pipeline",
  inboxes: "inbox",
}

export type ResolveManifestsOptions = {
  /** Leave out what `ctx.idMaps` already maps (a sync resolves only what is new). */
  skipMapped: boolean
  /** Whether the acting person may create rows for this category. */
  mayUse: (category: TemplateCategory) => boolean
  /**
   * Nest every top-level folder under one root per folder namespace, named
   * after the template. `create` makes fresh roots (an install); `reuse` finds
   * the existing ones by name (a sync of an install that made them).
   */
  installFolder?: { templateName: string; mode: "create" | "reuse" }
}

export type ResolveManifestsResult = {
  /** The first install-root folder, shown on the installation. */
  installFolderId: string | null
  /** Manifests the actor may not create that still had unmapped entries. */
  denied: ReadonlySet<ManifestKey>
}

const unmapped = <T>(
  manifest: Readonly<Record<string, T>>,
  ctx: TemplateInstallContext,
  key: ManifestKey,
  skipMapped: boolean,
): Record<string, T> => {
  if (!skipMapped) {
    return { ...manifest }
  }
  const mapped = ctx.idMaps[MANIFEST_ID_KIND[key]]
  return Object.fromEntries(
    Object.entries(manifest).filter(([sourceId]) => !mapped?.has(sourceId)),
  )
}

const rootSourceId = (folderType: string) => `__installRoot:${folderType}`

const findOrCreateRoot = async (
  ctx: TemplateInstallContext,
  name: string,
  folderType: string,
  mode: "create" | "reuse",
): Promise<string> => {
  if (mode === "reuse") {
    const existing = await ctx.tx.query.folderModel.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        folderType: folderType as FolderType,
        name,
        parentId: { isNull: true as const },
      },
      columns: { id: true },
    })
    if (existing) {
      return existing.id
    }
  }
  const [created] = await ctx.tx
    .insert(folderModel)
    .values({
      id: createId(),
      workspaceId: ctx.workspaceId,
      name,
      folderType: folderType as FolderType,
      parentId: null,
      paths: [],
    })
    .returning({ id: folderModel.id })
  return created.id
}

/**
 * Seeds `idMaps.folder` with one root per folder namespace and points every
 * top-level entry at it, so `resolveFolderManifest` nests it without a
 * fabricated manifest entry. Threading the parent at resolution time (rather
 * than `changeFolder` afterwards) avoids the shared-table scoping trap of
 * invariant 17.
 */
const nestUnderInstallRoots = async (
  ctx: TemplateInstallContext,
  folders: Record<string, TemplateFolderManifestEntry>,
  installFolder: NonNullable<ResolveManifestsOptions["installFolder"]>,
): Promise<{
  folders: Record<string, TemplateFolderManifestEntry>
  installFolderId: string | null
}> => {
  const folderTypes = new Set(
    Object.values(folders).map((entry) => entry.folderType),
  )
  if (folderTypes.size === 0) {
    return { folders, installFolderId: null }
  }
  ctx.idMaps.folder ??= new Map()
  let installFolderId: string | null = null
  for (const folderType of folderTypes) {
    const rootId = await findOrCreateRoot(
      ctx,
      installFolder.templateName,
      folderType,
      installFolder.mode,
    )
    ctx.idMaps.folder.set(rootSourceId(folderType), rootId)
    installFolderId ??= rootId
  }
  return {
    installFolderId,
    folders: Object.fromEntries(
      Object.entries(folders).map(([sourceId, entry]) => [
        sourceId,
        !entry.parentSourceId || entry.parentSourceId === rootFolderId
          ? { ...entry, parentSourceId: rootSourceId(entry.folderType) }
          : entry,
      ]),
    ),
  }
}

/** The install root of one folder namespace: the one already seeded, else found or made. */
const installRootFor = async (
  ctx: TemplateInstallContext,
  installFolder: NonNullable<ResolveManifestsOptions["installFolder"]>,
  folderType: FolderType,
): Promise<string> => {
  ctx.idMaps.folder ??= new Map()
  const seeded = ctx.idMaps.folder.get(rootSourceId(folderType))
  if (seeded) {
    return seeded
  }
  const rootId = await findOrCreateRoot(
    ctx,
    installFolder.templateName,
    folderType,
    installFolder.mode,
  )
  ctx.idMaps.folder.set(rootSourceId(folderType), rootId)
  return rootId
}

const groupFoldersByCategory = (
  folders: Record<string, TemplateFolderManifestEntry>,
): Map<TemplateCategory, Record<string, TemplateFolderManifestEntry>> => {
  const grouped = new Map<
    TemplateCategory,
    Record<string, TemplateFolderManifestEntry>
  >()
  for (const [sourceId, entry] of Object.entries(folders)) {
    const category = folderTypeToCategory(entry.folderType)
    grouped.set(category, { ...grouped.get(category), [sourceId]: entry })
  }
  return grouped
}

/**
 * Phase R, shared by install and sync: folders, custom fields, tags, product
 * categories, pipelines and inboxes, find-or-create only. One function, so the
 * two cannot drift (the sync used to skip folders entirely, leaving every
 * `folderId` it shipped unresolved).
 */
export const resolveManifests = async (
  ctx: TemplateInstallContext,
  manifests: TemplateExport["manifests"],
  options: ResolveManifestsOptions,
): Promise<ResolveManifestsResult> => {
  const { skipMapped, mayUse } = options
  const denied = new Set<ManifestKey>()
  const gated = (key: ManifestKey, size: number): boolean => {
    const category = MANIFEST_GATE[key]
    if (category && !mayUse(category)) {
      if (size > 0) {
        denied.add(key)
      }
      return false
    }
    return true
  }

  let installFolderId: string | null = null
  // Made only when a tag or field is actually created, so an install that
  // reuses every existing one leaves no empty folder behind.
  const lazyInstallRoot = (folderType: FolderType) => {
    const { installFolder } = options
    if (!installFolder) {
      return
    }
    return async () => {
      const rootId = await installRootFor(ctx, installFolder, folderType)
      installFolderId ??= rootId
      return rootId
    }
  }
  let folders = unmapped(manifests.folders, ctx, "folders", skipMapped)
  if (options.installFolder) {
    const nested = await nestUnderInstallRoots(
      ctx,
      folders,
      options.installFolder,
    )
    folders = nested.folders
    installFolderId = nested.installFolderId
  }
  for (const [category, group] of groupFoldersByCategory(folders)) {
    if (mayUse(category)) {
      await resolveFolderManifest(ctx, group, category)
    }
  }

  const customFields = unmapped(
    manifests.customFields,
    ctx,
    "customFields",
    skipMapped,
  )
  if (gated("customFields", Object.keys(customFields).length)) {
    await resolveCustomFieldManifest(ctx, customFields, {
      installFolder: lazyInstallRoot("customField"),
    })
  }
  const tags = unmapped(manifests.tags, ctx, "tags", skipMapped)
  if (gated("tags", Object.keys(tags).length)) {
    await resolveTagManifest(ctx, tags, {
      installFolder: lazyInstallRoot("tag"),
    })
  }
  const productCategories = unmapped(
    manifests.productCategories,
    ctx,
    "productCategories",
    skipMapped,
  )
  if (gated("productCategories", Object.keys(productCategories).length)) {
    await resolveProductCategoryManifest(ctx, productCategories)
  }

  if (gated("pipelines", Object.keys(manifests.pipelines).length)) {
    if (skipMapped) {
      // Already-mapped pipelines are not resolved again (their target may have
      // been renamed), but their stage and field mappings only ever lived in
      // the memory of the install that resolved them.
      const mapped = ctx.idMaps.pipeline
      await rebuildPipelineChildMappings(
        ctx,
        Object.fromEntries(
          Object.entries(manifests.pipelines).filter(([sourceId]) =>
            mapped?.has(sourceId),
          ),
        ),
        ctx.tx,
      )
    }
    await resolvePipelineManifest(
      ctx,
      unmapped(manifests.pipelines, ctx, "pipelines", skipMapped),
    )
  }
  await resolveInboxManifest(
    ctx,
    unmapped(manifests.inboxes, ctx, "inboxes", skipMapped),
  )
  return { installFolderId, denied }
}
