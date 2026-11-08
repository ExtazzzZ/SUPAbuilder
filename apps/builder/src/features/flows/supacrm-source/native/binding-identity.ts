import type { NativeSourceBinding } from "@/lib/source-authoring-native/authorization"

/** Stable document identity; fresh serialized props do not discard local edits. */
export const nativeSourceBindingIdentity = (binding: NativeSourceBinding) =>
  JSON.stringify([
    binding.bindingId,
    binding.workspaceId,
    binding.flowId,
    binding.registryId,
    binding.bindingVersion,
    [...binding.capabilities].sort(),
  ])
