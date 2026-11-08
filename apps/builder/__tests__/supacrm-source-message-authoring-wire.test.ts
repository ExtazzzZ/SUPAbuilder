// @vitest-environment node
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import {
  messageFieldEditSchema,
  messageLiteralViewRequestSchema,
  messageLiteralViewSchema,
  messageLiteralWriteSchema,
  plainTextTemplateSchema,
  registeredOwnerDescriptorSchema,
} from "../src/features/flows/supacrm-source/message-authoring/wire"

const span = {
  scenario_id: "s",
  block_id: "b",
  path: "params.markup",
  start: 0,
  end: 1,
  sequence: 0,
}
const pins = {
  field_id: "field",
  target: span,
  handler_id: "source-presentation/1",
  policy_revision: "p1",
  descriptor_version: "d1",
  schema_ref: "source.message.plain-text/1",
}
const expected = {
  expected_full_ir_id: "ir1",
  expected_source_hash: "hash1",
  expected_draft_version: 1,
}
const slot = { kind: "literal_slot", slot_id: "safe", declared_type: "str" }
const write = { ...pins, ...expected, text: "A" }
const view = {
  ...pins,
  source_revision: "ir1",
  source_hash: "hash1",
  draft_version: 1,
  slot,
  text: "A",
}
const descriptor = {
  field_id: "field",
  source_kind: "send_message",
  span,
  category: "template",
  owner: "source.presentation",
  edit_kind: "template",
  handler_id: pins.handler_id,
  policy_revision: "p1",
  full_ir_id: "ir1",
  descriptor_version: "d1",
  schema_ref: pins.schema_ref,
  evidence_refs: ["consumer-proof"],
  sensitivity: "ordinary",
  protected: false,
  value_mode: "ordinary_slot",
}

test("публичные схемы имеют точные поля frozen bundle и не включают private runtime artifact", () => {
  const raw = readFileSync(
    new URL(
      "../../../../v0/backend/app/modules/source_contract/message_authoring_draft.schema.json",
      import.meta.url,
    ),
  )
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "820801520cfdffedfb812bd5b529837ee955bd16fa064b8d783e2033603149ab",
  )
  const bundle = JSON.parse(raw.toString())
  const schemas = {
    MessageFieldEdit: messageFieldEditSchema,
    MessageLiteralWrite: messageLiteralWriteSchema,
    MessageLiteralView: messageLiteralViewSchema,
    PlainTextTemplate: plainTextTemplateSchema,
    RegisteredOwnerDescriptor: registeredOwnerDescriptorSchema,
  }
  for (const [name, schema] of Object.entries(schemas)) {
    expect(Object.keys(schema.shape).sort()).toEqual(
      Object.keys(bundle.schemas[name].properties).sort(),
    )
  }
})

test("строгие DTO отклоняют private refs, произвольный код и лишние поля", () => {
  expect(
    messageLiteralWriteSchema.safeParse({ ...write, payload_ref: "hidden" })
      .success,
  ).toBe(false)
  expect(
    messageLiteralViewSchema.safeParse({ ...view, template_ref: "hidden" })
      .success,
  ).toBe(false)
  expect(
    messageFieldEditSchema.safeParse({
      ...pins,
      ...expected,
      template: {
        runs: [{ kind: "call", function_id: "execute", arguments: [] }],
      },
    }).success,
  ).toBe(false)
  expect(
    registeredOwnerDescriptorSchema.safeParse({
      ...descriptor,
      token: "hidden",
    }).success,
  ).toBe(false)
})

test("template содержит ровно один literal_slot с точными T1 declared_type", () => {
  for (const declared_type of [
    "str",
    "num",
    "list",
    "dict",
    "bool",
    "attachment",
    "expr",
    "date",
    "datetime",
    "null",
  ]) {
    expect(
      plainTextTemplateSchema.safeParse({ runs: [{ ...slot, declared_type }] })
        .success,
    ).toBe(true)
  }
  for (const runs of [
    [],
    [slot, slot],
    [{ ...slot, declared_type: "string" }],
    [{ ...slot, value: "raw" }],
  ]) {
    expect(plainTextTemplateSchema.safeParse({ runs }).success).toBe(false)
  }
  expect(
    messageFieldEditSchema.parse({
      ...pins,
      ...expected,
      template: { runs: [slot] },
    }).schema_version,
  ).toBe("message-field-edit/1")
})

test("лимит 16384 учитывает Unicode code points, не UTF-16 code units", () => {
  expect(
    messageLiteralWriteSchema.safeParse({ ...write, text: "😀".repeat(16_384) })
      .success,
  ).toBe(true)
  expect(
    messageLiteralWriteSchema.safeParse({ ...write, text: "😀".repeat(16_385) })
      .success,
  ).toBe(false)
  expect(
    messageLiteralViewSchema.safeParse({ ...view, text: "😀".repeat(16_385) })
      .success,
  ).toBe(false)
  expect(
    messageLiteralWriteSchema.safeParse({
      ...write,
      expected_draft_version: -1,
    }).success,
  ).toBe(false)
  expect(
    messageLiteralViewSchema.safeParse({ ...view, draft_version: 0.5 }).success,
  ).toBe(false)
})

test("T7 view request не принимает raw hash, bool CAS и приватные поля", () => {
  const request = {
    schema_version: "message-field-view-request/1",
    field_id: "field",
    expected_full_ir_id: "ir1",
    expected_draft_version: 0,
  }
  expect(messageLiteralViewRequestSchema.safeParse(request).success).toBe(true)
  expect(
    messageLiteralViewRequestSchema.safeParse({
      ...request,
      expected_source_hash: "hash",
    }).success,
  ).toBe(false)
  expect(
    messageLiteralViewRequestSchema.safeParse({
      ...request,
      expected_draft_version: true,
    }).success,
  ).toBe(false)
})

test("default kind literal_slot восстанавливается точно по frozen LiteralSlotExpr", () => {
  expect(
    plainTextTemplateSchema.parse({
      runs: [{ slot_id: "handle", declared_type: "str" }],
    }),
  ).toEqual({
    context: "text",
    runs: [{ kind: "literal_slot", slot_id: "handle", declared_type: "str" }],
  })
})
