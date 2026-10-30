import { EXTERNAL_REFERENCE_KIND } from "./external-reference-kind"

/**
 * The entity a Condition row's `value` holds for each contact-filter `field`
 * whose value is an id rather than free text. A field absent from this map has
 * a plain value (a country, a date, a number) and is never rewritten.
 *
 * Lives here, not in `packages/database`, because `database` depends on
 * `flow-config`: `packages/database` pins this map against the real
 * `ContactFilterField` enum (`satisfies Partial<Record<ContactFilterField,
 * …>>`) and a test fails when an id-valued field is left out.
 *
 * The value is a string, a string array, or both (`eq`/`in`/`ne`/`notIn`), so
 * one rule covers every operator; `isEmpty` carries no value at all.
 */
export type ContactFilterFieldReference = {
  readonly kind: string
}

export const CONTACT_FILTER_FIELD_REFERENCE = {
  inbox: { kind: "inbox" },
  tags: { kind: "tag" },
  subscribedToDripCampaign: { kind: "sequence" },
  conversationAssigned: { kind: "workspaceMember" },
  entryPointsLinks: { kind: "reflink" },
  completedWhatsAppFlows: { kind: "whatsappFlow" },
  keywordsReceived: { kind: "automatedResponse" },
  executedFlow: { kind: "flow" },
  executedStep: { kind: "flowNode" },
  // Broadcasts are one-off sends that never travel with a template.
  broadcastSent: { kind: "broadcast" },
  broadcastDelivered: { kind: "broadcast" },
  broadcastSeen: { kind: "broadcast" },
  broadcastClicked: { kind: "broadcast" },
  broadcastFailed: { kind: "broadcast" },
  // Product ids: `boughtItems` and `shoppingCartContainsItems` take a string
  // or array of `Product` ids (`queries/contact-filter/commerce.ts`).
  boughtItems: { kind: "product" },
  shoppingCartContainsItems: { kind: "product" },
  // Third-party ids this product never owns.
  commentedOnPost: { kind: EXTERNAL_REFERENCE_KIND },
  clickedAd: { kind: EXTERNAL_REFERENCE_KIND },
  emailSent: { kind: EXTERNAL_REFERENCE_KIND },
  emailDelivered: { kind: EXTERNAL_REFERENCE_KIND },
  emailOpened: { kind: EXTERNAL_REFERENCE_KIND },
  emailClicked: { kind: EXTERNAL_REFERENCE_KIND },
} as const satisfies Readonly<Record<string, ContactFilterFieldReference>>
