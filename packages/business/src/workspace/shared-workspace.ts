const workspaceIdPattern = /^\d+$/

/** SUPAlogin выдаёт пользовательский доступ только к одному общему workspace. */
export const isSupaBuilderSharedMode = (): boolean =>
  Boolean(process.env.SUPALOGIN_ISSUER)

/** Проверка пользовательского доступа; машинные API-токены сюда не обращаются. */
export function isUserWorkspaceAllowed(workspaceId: string): boolean {
  if (!isSupaBuilderSharedMode()) {
    return true
  }
  const sharedId = process.env.SUPABUILDER_WORKSPACE_ID
  return Boolean(
    sharedId && workspaceIdPattern.test(sharedId) && workspaceId === sharedId,
  )
}
