import type { TemplateCategory } from "@chatbotx.io/database/partials"
import type { TemplateExport } from "@chatbotx.io/flow-config"
import { getTemplateAdapter, TEMPLATE_INSTALL_ORDER } from "./adapters/registry"
import type {
  StagedObject,
  StagedObjects,
  TemplateStageContext,
} from "./adapters/types"
import { entriesForCategory } from "./template-entries"

type Entry = Record<string, unknown> & { sourceId: string }

/**
 * The staging pre-phase shared by install and sync: every storage object the
 * payload ships is copied to its deterministic key BEFORE the apply
 * transaction opens, so no connection sits idle in a transaction while bytes
 * move. The transaction then only inserts rows (adapters read the result from
 * `ctx.staged`).
 *
 * Every copy is recorded through `ctx.trackCopiedObject`, so the caller can
 * delete them if the attempt fails. Keys derive from the installation id (for a
 * sync: installation id and sync id) and the source object, so a retry of the
 * same install or sync overwrites the same key. They are NOT under one
 * installation prefix (private AI files and public media each keep their own
 * storage namespace), so a prefix listing cannot find them: cleanup is per
 * path, and an attempt that dies before cleanup leaves at most the objects of
 * that one attempt. A redelivery of the same attempt overwrites them; if it
 * instead ends early (a sync skipped before staging), they stay behind as a
 * bounded orphan with no row pointing at them.
 */
export const stageTemplateObjects = async (input: {
  ctx: TemplateStageContext
  resources: TemplateExport["resources"]
  /** Narrows what is staged (a sync only stages what it is about to insert). */
  include?: (category: TemplateCategory, entry: Entry) => boolean
}): Promise<StagedObjects> => {
  const staged = new Map<string, StagedObject>()
  for (const category of TEMPLATE_INSTALL_ORDER) {
    const adapter = getTemplateAdapter(category)
    if (!adapter?.stage) {
      continue
    }
    const entries = entriesForCategory(input.resources, category).filter(
      (entry) => input.include?.(category, entry) ?? true,
    )
    if (entries.length === 0) {
      continue
    }
    for (const [key, value] of await adapter.stage(input.ctx, entries)) {
      staged.set(key, value)
    }
  }
  return staged
}
