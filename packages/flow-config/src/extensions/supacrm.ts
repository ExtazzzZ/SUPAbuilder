import { z } from "zod"
import {
  externalRequestStepDefaultFn,
  externalRequestStepSchema,
} from "../steps/external-request"

/** Compile extensions to supported primitives so publishing, UI and runtime share schemas. */
const handoffInput = z.object({
  crmBaseUrl: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
  serviceKey: z.string().min(1),
  botId: z.uuid(),
  peerId: z.string().min(1),
  paused: z.boolean().default(true),
})

export const supacrmExtensions = {
  "supacrm.handoff": {
    version: 1,
    inputSchema: handoffInput,
    compile(input: z.input<typeof handoffInput>) {
      const data = handoffInput.parse(input)
      const url = new URL(data.crmBaseUrl)
      if (url.username || url.password || url.search || url.hash) {
        throw new Error(
          "CRM base URL must not contain credentials, query or fragment",
        )
      }
      return externalRequestStepSchema.parse({
        ...externalRequestStepDefaultFn(),
        method: "POST",
        url: new URL("/api/v1/automation/actions/handoff", url).href,
        headers: [{ key: "X-Automation-Key", value: data.serviceKey }],
        body: {
          bodyType: "json",
          jsonBody: JSON.stringify({
            bot_id: data.botId,
            peer_id: data.peerId,
            paused: data.paused,
          }),
        },
        mapping: [],
      })
    },
  },
} as const
