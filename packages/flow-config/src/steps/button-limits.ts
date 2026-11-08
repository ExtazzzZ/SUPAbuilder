/**
 * Dependency-free button limits. Kept apart from `./button` (which pulls the
 * step schemas) so packages below flow-config — the database partials — can
 * read them through `@chatbotx.io/flow-config/button-limits` without loading
 * the whole flow schema graph.
 */
export const BUTTON_LABEL_MAX = 20

/** Максимум API-моста; ограничения остальных каналов проверяются при публикации. */
export const BUTTON_LABEL_SCHEMA_MAX = 80
