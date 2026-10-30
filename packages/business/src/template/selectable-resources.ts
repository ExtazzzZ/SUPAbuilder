import type { TemplateCategory } from "@chatbotx.io/database/partials"
import { templateSelectableResourceRepository } from "@chatbotx.io/database/repositories"
import {
  assertCanListTemplateCategory,
  type TemplateActor,
} from "./permissions"

const SELECTABLE_RESOURCE_PAGE_SIZE = 100
const SELECTABLE_RESOURCE_ALL_IDS_CAP = 1000

export type SelectableResourceItem = {
  id: string
  name: string
  folderName?: string
  badge?: string
}

export type ListSelectableResourcesResult = {
  items: SelectableResourceItem[]
  nextCursor: string | null
  total: number
  allIds?: string[]
}

type ListSelectableRows = (input: {
  workspaceId: string
  keyword?: string | null
  offset: number
  limit: number
}) => Promise<{
  rows: SelectableResourceItem[]
  total: number
  allIds?: string[]
}>

/** Manifest-only categories the picker never offers: they are only ever pulled in by what references them. */
type UnpickableCategory = "productCategories"

/**
 * Category -> its repository list. Every pickable category must have an entry
 * (a new one is a compile error until it does); `settings` bundles two tables
 * and is handled separately, and manifest-only categories have nothing to pick
 * and list empty.
 */
const SELECTABLE_LIST_BY_CATEGORY: Record<
  Exclude<TemplateCategory, "settings" | UnpickableCategory>,
  ListSelectableRows
> = {
  flows: (input) => templateSelectableResourceRepository.listFlows(input),
  tags: (input) => templateSelectableResourceRepository.listTags(input),
  customFields: (input) =>
    templateSelectableResourceRepository.listCustomFields(input),
  products: (input) => templateSelectableResourceRepository.listProducts(input),
  aiFunctions: (input) =>
    templateSelectableResourceRepository.listAIFunctions(input),
  aiAgents: (input) => templateSelectableResourceRepository.listAIAgents(input),
  calendars: (input) =>
    templateSelectableResourceRepository.listCalendars(input),
  webchats: (input) => templateSelectableResourceRepository.listWebchats(input),
  triggers: (input) => templateSelectableResourceRepository.listTriggers(input),
  fbCommentAutomations: (input) =>
    templateSelectableResourceRepository.listFbCommentAutomations(input),
  keywords: (input) => templateSelectableResourceRepository.listKeywords(input),
  entryPointLinks: (input) =>
    templateSelectableResourceRepository.listEntryPointLinks(input),
  sequences: (input) =>
    templateSelectableResourceRepository.listSequences(input),
  pipelines: (input) =>
    templateSelectableResourceRepository.listPipelines(input),
  aiMcpServers: (input) =>
    templateSelectableResourceRepository.listAIMcpServers(input),
  aiFiles: (input) => templateSelectableResourceRepository.listAIFiles(input),
  questionnaires: (input) =>
    templateSelectableResourceRepository.listQuestionnaires(input),
  couponTopics: (input) =>
    templateSelectableResourceRepository.listCouponTopics(input),
}

const isPickableCategory = (
  category: TemplateCategory,
): category is keyof typeof SELECTABLE_LIST_BY_CATEGORY =>
  Object.hasOwn(SELECTABLE_LIST_BY_CATEGORY, category)

const projectSelectableResourceRows = (
  result: { rows: SelectableResourceItem[]; total: number; allIds?: string[] },
  offset: number,
  limit: number,
): ListSelectableResourcesResult => ({
  items: result.rows,
  nextCursor:
    offset + result.rows.length < result.total ? String(offset + limit) : null,
  total: result.total,
  allIds: result.allIds,
})

/**
 * `settings` bundles two tables (`SavedReply`, `BotField`) under one
 * category, mirroring `settingsAdapter`'s two-kind entries. Search and
 * pagination run in memory over the combined, name-sorted list — both
 * tables are small, workspace-admin-configured settings, never large enough
 * to warrant a real cross-table paginated query.
 */
const listSelectableSettings = async (
  workspaceId: string,
  keyword: string | null | undefined,
  offset: number,
  limit: number,
): Promise<ListSelectableResourcesResult> => {
  const { savedReplies, botFields } =
    await templateSelectableResourceRepository.listSettings(workspaceId)

  const all = [
    ...savedReplies.map((row) => ({ id: row.id, name: row.shortcut })),
    ...botFields.map((row) => ({ id: row.id, name: row.name })),
  ].sort((a, b) => a.name.localeCompare(b.name))

  const filtered = keyword
    ? all.filter((row) =>
        row.name.toLowerCase().includes(keyword.toLowerCase()),
      )
    : all

  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)

  return {
    items: page,
    nextCursor: offset + page.length < total ? String(offset + limit) : null,
    total,
    allIds:
      offset === 0 && total <= SELECTABLE_RESOURCE_ALL_IDS_CAP
        ? filtered.map((row) => row.id)
        : undefined,
  }
}

/**
 * One unified query for the template picker's category tabs, so the
 * picker depends on a single seam rather than each category's own
 * incompatible list-query signature. Search is server-side `ilike`
 * (never client-side `.toLowerCase()`, which is locale-broken for
 * Vietnamese names). Returns `allIds` alongside page 1 whenever `total <=
 * SELECTABLE_RESOURCE_ALL_IDS_CAP`, so a `mode:"all"` -> uncheck-one-row
 * downgrade on the client can be exact instead of guessing at what "all"
 * means.
 */
export const listSelectableResources = async (input: {
  workspaceId: string
  category: TemplateCategory
  keyword?: string | null
  cursor?: string | null
  limit?: number | null
  actor: TemplateActor
}): Promise<ListSelectableResourcesResult> => {
  assertCanListTemplateCategory(input.actor, input.category)
  const limit = input.limit ?? SELECTABLE_RESOURCE_PAGE_SIZE
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0

  const categoryInput = {
    workspaceId: input.workspaceId,
    keyword: input.keyword,
    offset,
    limit,
  }

  if (input.category === "settings") {
    return listSelectableSettings(
      input.workspaceId,
      input.keyword,
      offset,
      limit,
    )
  }
  if (!isPickableCategory(input.category)) {
    return { items: [], nextCursor: null, total: 0 }
  }
  const listRows = SELECTABLE_LIST_BY_CATEGORY[input.category]
  return projectSelectableResourceRows(
    await listRows(categoryInput),
    offset,
    limit,
  )
}
