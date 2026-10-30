import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CONTACT_FILTER_FIELD_REFERENCE } from "../src/import-export/contact-filter-references"
import { EXTERNAL_REFERENCE_KIND } from "../src/import-export/external-reference-kind"
import {
  CROSS_FLOW_NODE_FIELD,
  DISCRIMINATED_REFERENCE_FIELDS,
  FLOW_REFERENCE_FIELD,
  PREFIXED_REFERENCE_ENTITY_KIND,
  REFERENCE_ARRAY_FIELD_ENTITY_KIND,
  REFERENCE_FIELD_ENTITY_KIND,
  REFERENCE_KIND_POLICY,
  REFERENCE_SLOT_SHAPE_BY_KEY,
  STEP_REFERENCE_OVERRIDES,
  STEP_REFERENCE_SLOT_SHAPE,
} from "../src/import-export/reference-fields"

const SOURCE_DIRS = ["steps", "nodes"].map((dir) =>
  join(import.meta.dirname, "..", "src", dir),
)

/**
 * `*Id` / `*Ids` keys that are NOT a reference to one of this workspace's
 * entities, and why. A key that is neither registered nor listed here fails
 * the test, so adding a new id-holding step field forces a decision.
 */
const NOT_A_WORKSPACE_REFERENCE: Readonly<Record<string, string>> = {
  // Third-party ids.
  accountId: "third-party account",
  activeCampaignFieldId: "third-party field",
  adAccountId: "Meta ad account",
  automationId: "third-party automation",
  campaignId: "third-party campaign",
  contentIds: "Meta CAPI content ids",
  conversionActionId: "Google Ads conversion action",
  customAudienceId: "Meta custom audience",
  dedupId: "event dedup key",
  groupId: "third-party group",
  listId: "third-party list",
  listIds: "third-party lists",
  // Ids inside a WhatsApp / Meta payload.
  buttonId: "button within the message",
  flowSourceId: "Meta WhatsApp flow id",
  flowVersionId: "WhatsApp flow token field",
  navigateScreenId: "WhatsApp flow screen",
  startScreenId: "WhatsApp flow screen",
  templateId: "template start-step marker",
  // Ids inside the flow graph itself.
  otherwiseId: "edge target within the same flow",
  stepId: "step within the same flow",
  // Runtime context carried by an event, never stored configuration.
  appointmentId: "runtime event data",
  broadcastId: "runtime event data",
  challengeId: "runtime event data",
  commentAutomationId: "runtime event data",
  commentId: "runtime event data",
  contactInboxId: "runtime event data",
  conversationId: "runtime event data",
  dispatchId: "runtime event data",
  sequenceStepId: "runtime event data",
  // A constant, not an id.
  maxFieldIds: "limit constant",
}

const registeredKeys = (): Set<string> => {
  const keys = new Set<string>([
    ...Object.keys(REFERENCE_FIELD_ENTITY_KIND),
    ...Object.keys(REFERENCE_ARRAY_FIELD_ENTITY_KIND),
    ...Object.keys(DISCRIMINATED_REFERENCE_FIELDS),
    FLOW_REFERENCE_FIELD,
    CROSS_FLOW_NODE_FIELD,
  ])
  for (const overrides of Object.values(STEP_REFERENCE_OVERRIDES)) {
    for (const path of Object.keys(overrides)) {
      keys.add(path.split(".").at(-1) ?? path)
    }
  }
  return keys
}

const idKeysDeclaredInSteps = (): Set<string> => {
  const keys = new Set<string>()
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(dir).filter((name) =>
      name.endsWith(".ts"),
    )) {
      const source = readFileSync(join(dir, file), "utf8")
      for (const match of source.matchAll(/^\s+(\w+(?:Id|Ids)):/gm)) {
        keys.add(match[1] ?? "")
      }
    }
  }
  keys.delete("")
  return keys
}

describe("reference registry completeness", () => {
  test("every id-holding step field is registered or explicitly not a reference", () => {
    const registered = registeredKeys()
    const undecided = [...idKeysDeclaredInSteps()].filter(
      (key) => !(registered.has(key) || key in NOT_A_WORKSPACE_REFERENCE),
    )

    expect(undecided).toEqual([])
  })

  test("nothing is both registered and listed as not a reference", () => {
    const registered = registeredKeys()
    const both = Object.keys(NOT_A_WORKSPACE_REFERENCE).filter((key) =>
      registered.has(key),
    )

    expect(both).toEqual([])
  })

  test("every entity kind any table can produce has a policy", () => {
    const kinds = new Set<string>([
      ...Object.values(REFERENCE_FIELD_ENTITY_KIND),
      ...Object.values(REFERENCE_ARRAY_FIELD_ENTITY_KIND),
      ...Object.values(PREFIXED_REFERENCE_ENTITY_KIND),
      ...Object.values(CONTACT_FILTER_FIELD_REFERENCE).map((ref) => ref.kind),
      ...Object.values(STEP_REFERENCE_OVERRIDES).flatMap((overrides) =>
        Object.values(overrides),
      ),
      ...Object.values(DISCRIMINATED_REFERENCE_FIELDS).flatMap((config) =>
        Object.values(config.kindByDiscriminator),
      ),
      "flow",
      "flowNode",
    ])
    kinds.delete(EXTERNAL_REFERENCE_KIND)

    const withoutPolicy = [...kinds].filter(
      (kind) => !(kind in REFERENCE_KIND_POLICY),
    )

    expect(withoutPolicy).toEqual([])
  })

  test("slot-shape tables only name registered keys", () => {
    const registered = registeredKeys()
    const unknown = Object.keys(REFERENCE_SLOT_SHAPE_BY_KEY).filter(
      (key) => !registered.has(key),
    )
    const stepKeys = Object.values(STEP_REFERENCE_SLOT_SHAPE).flatMap(
      (shapes) =>
        Object.keys(shapes).map((path) => path.split(".").at(-1) ?? path),
    )

    expect(unknown).toEqual([])
    expect(
      stepKeys.filter((key) => !registered.has(key) && key !== "id"),
    ).toEqual([])
  })
})
