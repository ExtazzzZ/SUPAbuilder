import {
  assertCanManageTemplates,
  assertCanUseTemplateCategories,
  previewDependencies,
  type TemplateActor,
} from "@chatbotx.io/business"
import type { TemplateSelection } from "@chatbotx.io/database/partials"

/**
 * What saving `selection` would take along on its own (the rows a selected one
 * needs, and the tags, custom fields and the like the snapshot ships). Same
 * gates as saving: managing templates, and every category the selection names.
 */
export const previewTemplateDependencies = async (input: {
  workspaceId: string
  tenantId: string
  selection: TemplateSelection
  actor: TemplateActor
}) => {
  assertCanManageTemplates(input.actor)
  const counts = Object.fromEntries(
    Object.entries(input.selection).map(([category, chosen]) => [
      category,
      chosen?.mode === "all" ? 1 : (chosen?.ids.length ?? 0),
    ]),
  )
  assertCanUseTemplateCategories(input.actor, counts)
  return await previewDependencies({
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    selection: input.selection,
  })
}
