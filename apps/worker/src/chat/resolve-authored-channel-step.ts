import { resolveContactVariablesDeep } from "@chatbotx.io/variables"

/** Типизированный API marker является данными; runtime MAIN выполняет подстановку. */
export const resolveAuthoredChannelStep = async <T>(
  contactId: string,
  step: T,
  channel: string,
  context: Parameters<typeof resolveContactVariablesDeep>[2],
): Promise<T> => {
  if (
    channel === "api" &&
    step &&
    typeof step === "object" &&
    "stepType" in step &&
    step.stepType === "sendText" &&
    "text" in step &&
    typeof step.text === "string" &&
    step.text.startsWith("SUPACRM_ACTION_V1:")
  ) {
    return step
  }
  return await resolveContactVariablesDeep(contactId, step, context, {
    spintax: true,
  })
}
