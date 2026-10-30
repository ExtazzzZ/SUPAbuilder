import { z } from "zod"

/**
 * See this package's README ("Exception: cross-cutting product enums") for why
 * a product enum lives in a generic-utils package: `@chatbotx.io/flow-config`
 * needs it for the flow-export custom-field manifest without depending on
 * `@chatbotx.io/database` (database already depends on flow-config).
 *
 * `@chatbotx.io/database/partials` re-exports this, so existing importers there
 * keep working unchanged. Mirrors the `channelTypes` precedent in `./channel.ts`.
 */
export const customFieldTypes = z.enum([
  "shortText",
  "email",
  "phoneNumber",
  "number",
  "date",
  "datetime",
  "boolean",
  "longText",
])
export type CustomFieldType = z.infer<typeof customFieldTypes>

/**
 * Contact-filter comparison operators. Lives here (not `@chatbotx.io/database`)
 * so a "use client" component (e.g. the filter condition dialog) can read the
 * enum without pulling in the database package. `@chatbotx.io/database/partials`
 * re-exports this for existing backend importers. Mirrors the `channelTypes`
 * precedent in `./channel.ts`.
 */
export const operatorTypes = z.enum([
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
  "eq",
  "ne",
  "startsWith",
  "endsWith",
  "contains",
  "notContains",
  "lt",
  "lte",
  "gt",
  "gte",
  "isBetween",
  "notBetween",
  "used",
])
export type OperatorType = z.infer<typeof operatorTypes>

/**
 * Canonical `(type, name)` identity used to match a flow export's custom-field
 * manifest against the target workspace's existing fields.
 *
 * Case- and whitespace-insensitive: the export carries whatever casing the
 * source workspace used, and an exact-case match would mint a duplicate field
 * on every casing drift. `type` is part of the key because the DB's unique
 * index is on `(workspaceId, type, name)` — two fields may share a name if
 * their types differ.
 *
 * Lives here, beside the enum, because both `customFieldService` (which builds
 * the resolved map) and `flowService` (which looks up into it) must fold keys
 * identically — two private copies would silently diverge and break the
 * lookup.
 */
export const customFieldResolutionKey = (field: {
  name: string
  type: CustomFieldType
}): string => `${field.type}:${field.name.trim().toLowerCase()}`

/**
 * The fold two custom-field names must share to count as "the same name": the
 * runtime resolves `{{name}}` without regard to type, so uniqueness that
 * matters to a message variable is case- and whitespace-insensitive across
 * ALL types, unlike the DB's `(workspaceId, type, name)` index.
 */
export const normalizeCustomFieldName = (name: string): string =>
  name.trim().toLowerCase()

const MAX_CUSTOM_FIELD_NAME_LENGTH = 255

/**
 * `<name>_<n>` for the smallest `n` whose normalized form is not in `taken`
 * (the normalized names already in use across every type). The base is
 * shortened when needed so the suffixed name stays within the length limit.
 */
export const allocateRenamedCustomFieldName = (
  name: string,
  taken: ReadonlySet<string>,
  maxLength = MAX_CUSTOM_FIELD_NAME_LENGTH,
): string => {
  const base = name.trim()
  for (let suffix = 1; ; suffix++) {
    const tail = `_${suffix}`
    const candidate = `${base.slice(0, Math.max(1, maxLength - tail.length))}${tail}`
    if (!taken.has(normalizeCustomFieldName(candidate))) {
      return candidate
    }
  }
}

// Boolean vocabulary = Postgres's own boolean input literals, so a stored
// value is always castable with `::boolean`. Shared by write-side
// normalization (business), the contact-filter SQL guard (database), and
// import/JS validation — one source, no drift.
export const BOOLEAN_TRUTHY_LITERALS = [
  "t",
  "true",
  "y",
  "yes",
  "on",
  "1",
] as const
export const BOOLEAN_FALSY_LITERALS = [
  "f",
  "false",
  "n",
  "no",
  "off",
  "0",
] as const

/** Regex source for the SQL guard: `lower(btrim(value)) ~ '<this>'`. */
export const BOOLEAN_LITERAL_PATTERN_SOURCE = `^(${[
  ...BOOLEAN_TRUTHY_LITERALS,
  ...BOOLEAN_FALSY_LITERALS,
].join("|")})$`

const TRUTHY = new Set<string>(BOOLEAN_TRUTHY_LITERALS)
const FALSY = new Set<string>(BOOLEAN_FALSY_LITERALS)

/** Strict: recognized literal → "true"/"false", anything else → null (callers skip/reject). */
export const canonicalBooleanLiteral = (
  raw: string,
): "true" | "false" | null => {
  const literal = raw.trim().toLowerCase()
  if (TRUTHY.has(literal)) {
    return "true"
  }
  return FALSY.has(literal) ? "false" : null
}

/**
 * Generous: blank/falsy literal → "false", everything else → "true".
 * Never throws — flow/trigger writes carry arbitrary user text and a chatbot
 * must not crash on it.
 */
export const coerceBooleanLiteral = (raw: string): "true" | "false" => {
  const literal = raw.trim().toLowerCase()
  return literal.length === 0 || FALSY.has(literal) ? "false" : "true"
}

/**
 * Number canonicalizer: whatever JS `Number()` accepts ("+1", "1.", "1e3",
 * "0x10") → canonical decimal string ("007" → "7"); blank or non-finite →
 * null (callers decide: throw, skip, or "unset").
 */
export const canonicalNumberLiteral = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? String(parsed) : null
}
