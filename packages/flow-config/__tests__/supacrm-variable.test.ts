import { describe, expect, it } from "vitest"
import {
  getSupacrmVariable,
  isSupacrmVariableCommand,
  supacrmVariableCommand,
} from "../src/extensions/supacrm-variable"
import { publishFlowSchema } from "../src/index"
import {
  createSupacrmVariableNode,
  selectSupacrmVariable,
} from "../src/nodes/supacrm-variable"

const render = {
  action: "variables.render",
  payload: { key: "language", template: "Язык: {{value}}" },
} as const

describe("Переменные CRM используют типизированный API marker", () => {
  it("создаёт рабочий API node, без custom fields и скопированных значений", () => {
    const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
    expect(
      publishFlowSchema.parse({ nodes: [node], edges: [] }).nodes[0],
    ).toEqual(node)
    expect(node.data.details.beforeStep.channel).toBe("api")
    expect(node.data.details.steps[0]).toMatchObject({
      text: `SUPACRM_ACTION_V1:${JSON.stringify(render)}`,
    })
    expect(isSupacrmVariableCommand(supacrmVariableCommand(render))).toBe(true)
  })
  it("не публикует пустую настройку или расходящиеся marker и metadata", () => {
    expect(
      publishFlowSchema.safeParse({
        nodes: [createSupacrmVariableNode({})],
        edges: [],
      }).success,
    ).toBe(false)
    const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
    node.data.details.steps[0] = {
      ...node.data.details.steps[0],
      text: "изменённый marker",
    } as (typeof node.data.details.steps)[0]
    expect(
      publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
    ).toBe(false)
  })
  it("сохраняет JSON типы и требует текст подтверждения для set", () => {
    const set = {
      action: "variables.set",
      payload: {
        key: "language",
        value: false,
        expected_revision: 0,
        source_fingerprint: "f".repeat(64),
        confirmation: "Изменено",
      },
    } as const
    expect(
      JSON.parse(supacrmVariableCommand(set).split("SUPACRM_ACTION_V1:")[1])
        .payload.value,
    ).toBe(false)
    expect(() =>
      supacrmVariableCommand({
        ...set,
        payload: { key: "language", value: false },
      } as never),
    ).toThrow()
    expect(() =>
      supacrmVariableCommand({
        ...render,
        payload: { ...render.payload, peer_id: "123" },
      } as never),
    ).toThrow()
  })
  it("строго распознаёт команды для пропуска обычной ChatbotX interpolation", () => {
    expect(isSupacrmVariableCommand("SUPACRM_ACTION_V1:{}")).toBe(false)
    expect(isSupacrmVariableCommand("обычный {{value}}")).toBe(false)
  })
})

it.each([
  "без подстановки",
  "{{value}} {{value}}",
])("отвергает несовместимый шаблон %s до публикации", (template) => {
  const command = { ...render, payload: { ...render.payload, template } }
  expect(() => supacrmVariableCommand(command)).toThrow()
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
  node.data.details.supacrmVariable = command
  const step = node.data.details.steps[0]
  node.data.details.steps[0] = {
    ...step,
    text: `SUPACRM_ACTION_V1:${JSON.stringify(command)}`,
  } as typeof step
  expect(
    publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
  ).toBe(false)
})

it.each([
  "then_text",
  "else_text",
] as const)("не публикует условие с пустым %s", (field) => {
  const command = {
    action: "variables.condition",
    payload: {
      key: "language",
      operator: "eq",
      operand: false,
      then_text: "Да",
      else_text: "Нет",
      [field]: "",
    },
  } as const
  expect(() => supacrmVariableCommand(command)).toThrow()
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
  node.data.details.supacrmVariable = command
  const step = node.data.details.steps[0]
  node.data.details.steps[0] = {
    ...step,
    text: `SUPACRM_ACTION_V1:${JSON.stringify(command)}`,
  } as typeof step
  expect(
    publishFlowSchema.safeParse({ nodes: [node], edges: [] }).success,
  ).toBe(false)
})

it("распознаёт только типизированную metadata, не произвольный JSON", () => {
  for (const input of [
    null,
    undefined,
    {},
    { supacrmVariable: { ...render, credentials: "forbidden" } },
  ]) {
    expect(getSupacrmVariable(input)).toBeNull()
  }
  expect(getSupacrmVariable({ supacrmVariable: render })).toEqual(render)
  expect(isSupacrmVariableCommand("SUPACRM_ACTION_V1:not-json")).toBe(false)
})

it("не публикует variable marker через чужой channel или mixed semantic block", () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
  const channel = structuredClone(node)
  channel.data.details.beforeStep.channel = "telegram"
  expect(
    publishFlowSchema.safeParse({ nodes: [channel], edges: [] }).success,
  ).toBe(false)
  const mixed = structuredClone(node)
  mixed.data.details.supacrmProduct = {
    catalogItemId: "123e4567-e89b-42d3-a456-426614174000",
  }
  expect(
    publishFlowSchema.safeParse({ nodes: [mixed], edges: [] }).success,
  ).toBe(false)
})

it("сохраняет stable step id при смене действия и ограничивает размер marker", () => {
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), render)
  const reset = {
    action: "variables.reset",
    payload: {
      key: "language",
      expected_revision: 1,
      source_fingerprint: "f".repeat(64),
      confirmation: "Сброшено",
    },
  } as const
  expect(selectSupacrmVariable(node, reset).data.details.steps[0].id).toBe(
    node.data.details.steps[0].id,
  )
  expect(() =>
    supacrmVariableCommand({
      action: "variables.set",
      payload: { ...reset.payload, value: "a".repeat(4000) },
    }),
  ).toThrow()
})

it("компилирует условие с типизированным operand и literal ветками", () => {
  const command = {
    action: "variables.condition",
    payload: {
      key: "language",
      operator: "eq",
      operand: null,
      then_text: "Да",
      else_text: "Нет",
    },
  } as const
  const node = selectSupacrmVariable(createSupacrmVariableNode({}), command)
  expect(
    publishFlowSchema.parse({ nodes: [node], edges: [] }).nodes[0],
  ).toEqual(node)
  expect(supacrmVariableCommand(command)).toContain('"operand":null')
})

it("сохраняет legacy canonical set/reset без новых сериализуемых defaults", () => {
  for (const action of ["variables.set", "variables.reset"] as const) {
    const payload = {
      key: "language",
      expected_revision: 2,
      source_fingerprint: "f".repeat(64),
      confirmation: "Готово",
      ...(action === "variables.set" ? { value: null } : {}),
    }
    const legacy = `SUPACRM_ACTION_V1:${JSON.stringify({ action, payload })}`
    expect(isSupacrmVariableCommand(legacy)).toBe(true)
    expect(supacrmVariableCommand({ action, payload } as never)).toBe(legacy)
  }
})

it.each([
  "variables.set",
  "variables.reset",
] as const)("компилирует %s с autoCAS без парных полей", (action) => {
  const command = {
    action,
    payload: {
      key: "language",
      confirmation: "Готово",
      ...(action === "variables.set" ? { value: null } : {}),
    },
  }
  const marker = supacrmVariableCommand(command as never)
  expect(isSupacrmVariableCommand(marker)).toBe(true)
  expect(marker).not.toContain("expected_revision")
  expect(marker).not.toContain("source_fingerprint")
  expect(marker).not.toContain("value_from")
  const node = selectSupacrmVariable(
    createSupacrmVariableNode({}),
    command as never,
  )
  expect(
    publishFlowSchema.parse({ nodes: [node], edges: [] }).nodes[0],
  ).toEqual(node)
})

it("принимает только парный CAS и явный источник set без произвольных ссылок", () => {
  const payload = { key: "language", confirmation: "Готово" }
  const inbound = {
    action: "variables.set",
    payload: { ...payload, value_from: "inbound_text" },
  } as const
  expect(isSupacrmVariableCommand(supacrmVariableCommand(inbound))).toBe(true)
  expect(supacrmVariableCommand(inbound)).not.toContain('"value":')
  for (const value of [null, false, 0]) {
    expect(() =>
      supacrmVariableCommand({
        action: "variables.set",
        payload: { ...payload, value },
      }),
    ).not.toThrow()
  }
  for (const invalid of [
    { ...payload, expected_revision: 0, value: null },
    { ...payload, source_fingerprint: "f".repeat(64), value: null },
    payload,
    { ...payload, value_from: "literal" },
    { ...payload, value: undefined },
    { ...payload, value_from: "inbound_text", value: null },
    { ...payload, value_from: "other_job" },
    { ...payload, value_from: "inbound_text", peer_id: "foreign" },
  ]) {
    expect(() =>
      supacrmVariableCommand({
        action: "variables.set",
        payload: invalid,
      } as never),
    ).toThrow()
  }
})
