import { expect, test } from "vitest"
import { sourceIdentityV1Schema } from "../src/source/identity"

const base = {
  project_id: "project",
  platform: "telegram",
  bot_id: "real-platform-bot",
  peer_id: "real-platform-peer",
}
const target = () => ({
  ...base,
  kind: "target",
  namespace: "server-namespace",
  registry_id: "crm-bot",
  channel_id: "server-channel",
  native_user_id: "crm-user",
  native_conversation_id: "crm-conversation",
  migration_state: "new",
  legacy_provenance: null,
})
test("новый native client не требует и не придумывает legacy IDs", () => {
  expect(sourceIdentityV1Schema.parse(target())).toEqual(target())
  expect(
    sourceIdentityV1Schema.safeParse({
      ...target(),
      source_chat_id: "crm-conversation",
    }).success,
  ).toBe(false)
})
test("старый legacy JSON совместим; unknown kind не угадывается", () => {
  const old = {
    ...base,
    source_user_id: "source-user",
    source_chat_id: "source-chat",
    channel_id: null,
  }
  expect(sourceIdentityV1Schema.parse(old)).toEqual(old)
  expect(
    sourceIdentityV1Schema.safeParse({ ...old, kind: "other" }).success,
  ).toBe(false)
})
test("migrated identity явно различает unresolved и verified provenance", () => {
  expect(
    sourceIdentityV1Schema.safeParse({
      ...target(),
      migration_state: "migrated",
    }).success,
  ).toBe(false)
  const unresolved = {
    ...target(),
    migration_state: "migrated",
    legacy_provenance: { status: "unresolved" },
  }
  expect(sourceIdentityV1Schema.safeParse(unresolved).success).toBe(true)
  expect(
    sourceIdentityV1Schema.safeParse({
      ...unresolved,
      legacy_provenance: { status: "verified" },
    }).success,
  ).toBe(false)
  expect(
    sourceIdentityV1Schema.safeParse({
      ...target(),
      legacy_provenance: { status: "unresolved" },
    }).success,
  ).toBe(false)
})
