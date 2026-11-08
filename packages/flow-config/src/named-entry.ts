/** Именованное событие разрешается в единственный опубликованный блок. */
export function resolveNamedEntry(
  nodes: readonly { id: string; data: { details: unknown } }[],
  entry: "apple.feedback",
): string {
  const matches = nodes.filter((node) => {
    const details = node.data.details as { supacrmReminder?: { anchor?: string } }
    return entry === "apple.feedback" && details.supacrmReminder?.anchor === "customer_confirmed"
  })
  if (matches.length !== 1) throw new Error("Именованная точка входа Apple отсутствует или неоднозначна")
  return matches[0]!.id
}
