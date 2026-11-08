import { z } from "zod"
import { flowValidationCodes } from "../validation-codes"

const key = z.string().max(200)
const cas = {
  key,
  expected_revision: z.number().int().nonnegative().optional(),
  source_fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  confirmation: z.string().min(1).max(2000),
}

const pairedCas = (payload: {
  expected_revision?: number
  source_fingerprint?: string
}) =>
  (payload.expected_revision === undefined) ===
  (payload.source_fingerprint === undefined)

/** Текущие значения MAIN не входят в граф; autoCAS фиксируется сервером при выполнении. */
export const supacrmVariableSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("variables.render"),
    payload: z.strictObject({
      key,
      template: z
        .string()
        .min(1)
        .max(2000)
        .refine(
          (value) => value.split("{{value}}").length === 2,
          "supacrmVariableInvalid",
        ),
    }),
  }),
  z.strictObject({
    action: z.literal("variables.condition"),
    payload: z.strictObject({
      key,
      operator: z.enum(["eq", "contains", "starts_with", "gt", "gte", "lte"]),
      operand: z.json(),
      then_text: z.string().min(1).max(2000),
      else_text: z.string().min(1).max(2000),
    }),
  }),
  z.strictObject({
    action: z.literal("variables.set"),
    payload: z
      .strictObject({
        ...cas,
        value_from: z.enum(["literal", "inbound_text"]).optional(),
        value: z.json().optional(),
      })
      .refine(pairedCas, "supacrmVariableInvalid")
      .refine(
        (payload) =>
          payload.value_from === "inbound_text"
            ? !Object.hasOwn(payload, "value")
            : Object.hasOwn(payload, "value") && payload.value !== undefined,
        "supacrmVariableInvalid",
      ),
  }),
  z.strictObject({
    action: z.literal("variables.reset"),
    payload: z.strictObject(cas).refine(pairedCas, "supacrmVariableInvalid"),
  }),
])
export type SupacrmVariable = z.infer<typeof supacrmVariableSchema>

export const supacrmVariableCommand = (input: SupacrmVariable): string => {
  const command = supacrmVariableSchema.parse(input)
  z.string().min(1).parse(command.payload.key)
  const text = `SUPACRM_ACTION_V1:${JSON.stringify(command)}`
  z.string().max(4000).parse(text)
  return text
}

export const getSupacrmVariable = (
  details: unknown,
): SupacrmVariable | null => {
  if (
    !details ||
    typeof details !== "object" ||
    !("supacrmVariable" in details)
  ) {
    return null
  }
  const parsed = supacrmVariableSchema.safeParse(details.supacrmVariable)
  return parsed.success ? parsed.data : null
}

/** Команда является данными, поэтому ChatbotX не подставляет custom fields/spintax в JSON. */
export const isSupacrmVariableCommand = (text: unknown): boolean => {
  if (typeof text !== "string" || !text.startsWith("SUPACRM_ACTION_V1:")) {
    return false
  }
  try {
    return (
      supacrmVariableCommand(
        JSON.parse(text.slice("SUPACRM_ACTION_V1:".length)),
      ) === text
    )
  } catch {
    return false
  }
}

export const refineSupacrmVariable = (
  details: {
    supacrmVariable?: SupacrmVariable
    supacrmProduct?: unknown
    beforeStep: { channel: string }
    steps: unknown[]
    quickReplies: unknown[]
  },
  ctx: z.RefinementCtx,
): void => {
  if (!details.supacrmVariable) {
    return
  }
  const step = details.steps[0]
  let valid = false
  try {
    valid =
      !details.supacrmProduct &&
      details.beforeStep.channel === "api" &&
      details.quickReplies.length === 0 &&
      details.steps.length === 1 &&
      !!step &&
      typeof step === "object" &&
      "stepType" in step &&
      step.stepType === "sendText" &&
      "text" in step &&
      step.text === supacrmVariableCommand(details.supacrmVariable) &&
      "buttons" in step &&
      Array.isArray(step.buttons) &&
      step.buttons.length === 0
  } catch {
    valid = false
  }
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      path: ["supacrmVariable"],
      message: flowValidationCodes.supacrmVariableInvalid,
    })
  }
}
