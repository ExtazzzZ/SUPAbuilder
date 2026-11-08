import { z } from "zod"

const id = z.string().min(1)
const base = {
  project_id: id,
  platform: z.enum(["telegram", "vk"]),
  bot_id: id,
  peer_id: id,
}
const legacy = z.strictObject({
  ...base,
  kind: z.literal("legacy").optional(),
  source_user_id: id,
  source_chat_id: id,
  channel_id: z.string().nullable().default(null),
})
const optionalId = id.nullable().default(null)
const provenance = z
  .strictObject({
    status: z.enum(["verified", "unresolved"]),
    mapping_ref: optionalId,
    source_project_id: optionalId,
    source_channel_id: optionalId,
    source_user_id: optionalId,
    source_chat_id: optionalId,
  })
  .refine(
    (p) =>
      p.status !== "verified" ||
      [
        p.mapping_ref,
        p.source_project_id,
        p.source_channel_id,
        p.source_user_id,
        p.source_chat_id,
      ].every((v) => v !== null),
  )
const target = z
  .strictObject({
    ...base,
    kind: z.literal("target"),
    namespace: id,
    registry_id: id,
    channel_id: id,
    native_user_id: id,
    native_conversation_id: id,
    migration_state: z.enum(["new", "migrated"]),
    legacy_provenance: provenance.nullable().default(null),
  })
  .refine((p) =>
    p.migration_state === "new"
      ? p.legacy_provenance === null
      : p.legacy_provenance !== null,
  )

/** T1 source-runtime 1.2.0: native CRM IDs не подставляются в legacy dimensions. */
export const sourceIdentityV1Schema = z.union([legacy, target])
export type SourceIdentityV1 = z.infer<typeof sourceIdentityV1Schema>
