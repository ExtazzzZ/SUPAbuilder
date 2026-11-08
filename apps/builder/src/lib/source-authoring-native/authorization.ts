/** Authority этого модуля предоставляют только owning server adapters. */
export type NativeSourceTarget = Readonly<{
  workspaceId: string
  flowId: string
}>
export type NativeSourceIdentity = Readonly<{
  workspaceId: string
  subject: string
  flows: boolean
}>
export type NativeSourceBinding = Readonly<{
  kind: "source"
  bindingId: string
  workspaceId: string
  flowId: string
  registryId: string
  bindingVersion: 1
  capabilities: readonly string[]
}>
export type NativeSourceAuthorizationPorts = {
  identity(workspaceId: string): Promise<NativeSourceIdentity | null>
  binding(target: NativeSourceTarget): Promise<unknown>
}
export type NativeSourceAuthorization = Readonly<{
  binding: NativeSourceBinding
  actor: string
}>

const nativeId = /^[1-9][0-9]{0,19}$/
const invalidSubject = /[\r\n]/
const registryId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function authorizeNativeSource(
  target: NativeSourceTarget,
  ports: NativeSourceAuthorizationPorts,
): Promise<NativeSourceAuthorization | null> {
  if (!(nativeId.test(target.workspaceId) && nativeId.test(target.flowId))) {
    return null
  }
  try {
    const identity = await ports.identity(target.workspaceId)
    if (
      !identity ||
      identity.workspaceId !== target.workspaceId ||
      identity.flows !== true ||
      !identity.subject ||
      identity.subject.length > 256 ||
      invalidSubject.test(identity.subject)
    ) {
      return null
    }
    const value = await ports.binding(target)
    if (!value || typeof value !== "object") {
      return null
    }
    const binding = value as NativeSourceBinding
    if (
      binding.kind !== "source" ||
      binding.workspaceId !== target.workspaceId ||
      binding.flowId !== target.flowId ||
      typeof binding.bindingId !== "string" ||
      !binding.bindingId ||
      binding.bindingVersion !== 1 ||
      !registryId.test(binding.registryId ?? "") ||
      !Array.isArray(binding.capabilities) ||
      !["view", "slot", "compile", "validate", "publish"].every((cap) =>
        binding.capabilities.includes(cap),
      )
    ) {
      return null
    }
    return Object.freeze({
      binding: Object.freeze({
        kind: "source",
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        flowId: binding.flowId,
        registryId: binding.registryId,
        bindingVersion: binding.bindingVersion,
        capabilities: Object.freeze([...binding.capabilities]),
      }),
      actor: identity.subject,
    })
  } catch {
    return null
  }
}
