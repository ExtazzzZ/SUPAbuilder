import {
  systemFieldTypes,
  type TemplateResourceCategory,
} from "@chatbotx.io/database/partials"
import { collectReferencesByKind } from "@chatbotx.io/flow-config"
import { isNumericId } from "@chatbotx.io/utils/id"
import { VARIABLE_PLACEHOLDER_SOURCE } from "@chatbotx.io/utils/variables"
import { z } from "zod"
import type { TemplateHardDependency } from "./adapters/types"
import {
  collectTriggerConditionReferences,
  triggerConditionRowSchema,
} from "./trigger-conditions"

/**
 * Resource kinds a flow or trigger can name by id whose rows a template ships
 * as their own category: the install remaps them by id, so the row has to
 * travel with whatever points at it.
 */
const DEPENDENCY_CATEGORY_BY_KIND = {
  sequence: "sequences",
  questionnaire: "questionnaires",
  couponTopic: "couponTopics",
} as const satisfies Partial<Record<string, TemplateResourceCategory>>

/** The shipped-category rows `value` names, as hard dependencies of its owner. */
export const collectResourceDependencies = (
  value: unknown,
): TemplateHardDependency[] => {
  const kinds = Object.keys(
    DEPENDENCY_CATEGORY_BY_KIND,
  ) as (keyof typeof DEPENDENCY_CATEGORY_BY_KIND)[]
  const byKind = collectReferencesByKind(value, kinds)
  return kinds.flatMap((kind) =>
    [...(byKind.get(kind) ?? [])].map((sourceId) => ({
      category: DEPENDENCY_CATEGORY_BY_KIND[kind],
      sourceId,
    })),
  )
}

/** Same ceiling the flow-config walkers use over attacker-shaped JSON. */
const MAX_WALK_DEPTH = 512

const COUPON_PREFIX = "coupon:"
const BOT_FIELD_PREFIX = "bot_field:"
const PIPELINE_PREFIX = "pipelines."
const RAW_PREFIX = "raw:"

export type ManifestReferences = {
  tagIds: Set<string>
  customFieldIds: Set<string>
  /** Custom-field names used as `{{name}}` / `{{raw:name}}` tokens. */
  customFieldNames: Set<string>
}

/**
 * The custom-field name a `{{token}}` addresses, or `null` when the token is
 * something else. Mirrors the runtime's resolver order
 * (`variables/src/contact-variable.ts`): a system field wins over a custom
 * field of the same name, and coupon / pipeline / bot-field tokens never reach
 * the custom-field resolver.
 */
export const customFieldNameFromToken = (token: string): string | null => {
  const name = token.trim()
  if (
    name.startsWith(COUPON_PREFIX) ||
    name.startsWith(BOT_FIELD_PREFIX) ||
    name.startsWith(PIPELINE_PREFIX)
  ) {
    return null
  }
  const customName = name.startsWith(RAW_PREFIX)
    ? name.slice(RAW_PREFIX.length)
    : name
  if (
    !customName ||
    (systemFieldTypes.options as readonly string[]).includes(name)
  ) {
    return null
  }
  return customName
}

const collectTokenNames = (
  value: unknown,
  names: Set<string>,
  depth = 0,
): void => {
  if (depth > MAX_WALK_DEPTH) {
    return
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(
      new RegExp(VARIABLE_PLACEHOLDER_SOURCE, "g"),
    )) {
      const name = customFieldNameFromToken(match[1] ?? "")
      if (name) {
        names.add(name)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTokenNames(item, names, depth + 1)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      collectTokenNames(child, names, depth + 1)
    }
  }
}

/** The ids a trigger entry's condition rows name; empty for any other entry. */
const conditionReferencesOf = (entry: unknown) => {
  const rows = z
    .array(triggerConditionRowSchema)
    .safeParse((entry as { conditions?: unknown } | null)?.conditions)
  return collectTriggerConditionReferences(rows.success ? rows.data : [])
}

/**
 * Every tag and custom field a set of collected resource entries refers to,
 * read the same two ways the install remaps them: from reference slots (the
 * shared walker, so collection and remap cannot drift) and from `{{name}}`
 * tokens embedded in any string. System-field slugs sharing a slot with a real
 * id are excluded by `isNumericId`.
 */
export const collectManifestReferences = (
  entries: readonly unknown[],
): ManifestReferences => {
  const references: ManifestReferences = {
    tagIds: new Set(),
    customFieldIds: new Set(),
    customFieldNames: new Set(),
  }
  for (const entry of entries) {
    const byKind = collectReferencesByKind(entry, ["tag", "customField"])
    for (const id of byKind.get("tag") ?? []) {
      references.tagIds.add(id)
    }
    for (const id of byKind.get("customField") ?? []) {
      if (isNumericId(id)) {
        references.customFieldIds.add(id)
      }
    }
    collectTokenNames(entry, references.customFieldNames)
    for (const [kind, ids] of conditionReferencesOf(entry)) {
      const target =
        kind === "tag" ? references.tagIds : references.customFieldIds
      if (kind === "tag" || kind === "customField") {
        for (const id of ids) {
          target.add(id)
        }
      }
    }
  }
  return references
}
