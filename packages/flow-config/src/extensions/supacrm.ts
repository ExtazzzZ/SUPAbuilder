import { z } from "zod"
import { sendTextStepDefaultFn } from "../steps/send-text"

// Команда доставляется через серверный API-канал с существующей HMAC-подписью.
// Идентичность клиента и credentials определяются CRM по каналу, а не flow.
const handoffInput = z.strictObject({
  paused: z.literal(true).default(true),
})
const catalogInput = z.strictObject({})

export const supacrmExtensions = {
  "supacrm.handoff": {
    version: 2,
    inputSchema: handoffInput,
    compile(input: z.input<typeof handoffInput>) {
      const data = handoffInput.parse(input)
      return sendTextStepDefaultFn({
        text: `SUPACRM_ACTION_V1:${JSON.stringify({
          action: "operator.handoff", payload: { paused: data.paused },
        })}`,
      })
    },
  },
  "supacrm.catalog": {
    version: 1,
    inputSchema: catalogInput,
    compile(input: z.input<typeof catalogInput>) {
      catalogInput.parse(input)
      return sendTextStepDefaultFn({
        text: 'SUPACRM_ACTION_V1:{"action":"catalog.list","payload":{}}',
      })
    },
  },
} as const
