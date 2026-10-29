import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

import { zodFieldReference } from "../field-reference"
import {
  errorStateDefaultFn,
  errorStateSchema,
  skipStateDefaultFn,
  skipStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

// SAM runs only through the workspace Muse (Meta Model API) integration, so
// the model is fixed and not a step setting.
export const AI_SEGMENT_IMAGE_MODEL = "sam-3.1" as const
export const AI_SEGMENT_IMAGE_TARGET_MAX_LENGTH = 160

export const aiSegmentImageMatchSelection = z.enum(["all", "largest"])
export type AISegmentImageMatchSelection = z.infer<
  typeof aiSegmentImageMatchSelection
>

export const aiSegmentImageOutputFormat = z.enum(["cutout", "mask"])
export type AISegmentImageOutputFormat = z.infer<
  typeof aiSegmentImageOutputFormat
>

export const aiSegmentImageSchema = z
  .object({
    id: zodBigintAsString().describe(
      "Step id (numeric string), unique within the flow.",
    ),
    stepType: z
      .literal(stepTypes.enum.aiSegmentImage)
      .describe('Step type discriminator: "aiSegmentImage".'),
    inputFieldId: zodFieldReference().describe(
      "Custom field holding the source image URL.",
    ),
    target: z
      .string()
      .trim()
      .min(1)
      .max(AI_SEGMENT_IMAGE_TARGET_MAX_LENGTH)
      .describe(
        'Short concrete noun phrase naming the object to segment, e.g. "red car" or "product box". Not a command or question.',
      ),
    matchSelection: aiSegmentImageMatchSelection.describe(
      '"largest" keeps only the largest matched object; "all" combines every match.',
    ),
    outputFormat: aiSegmentImageOutputFormat.describe(
      '"cutout" writes a PNG of the object on a transparent background; "mask" writes a black/white PNG mask.',
    ),
    outputFieldId: zodFieldReference().describe(
      "Custom field that receives the output PNG URL. May equal inputFieldId to replace the source image.",
    ),
    detailsOutputFieldId: zodFieldReference()
      .optional()
      .describe(
        "Optional custom field that receives JSON detection details ({ count, boxes, source }).",
      ),
    states: z
      .tuple([successStateSchema, skipStateSchema, errorStateSchema])
      .describe(
        "Exactly [success, skip, error]: success = object found, skip = no object found, error = processing failed.",
      ),
  })
  .superRefine((value, ctx) => {
    if (!value.detailsOutputFieldId) {
      return
    }
    if (value.detailsOutputFieldId === value.outputFieldId) {
      ctx.addIssue({
        code: "custom",
        path: ["detailsOutputFieldId"],
        message: "Details field must differ from the output image field",
      })
    }
    if (value.detailsOutputFieldId === value.inputFieldId) {
      ctx.addIssue({
        code: "custom",
        path: ["detailsOutputFieldId"],
        message: "Details field must differ from the source image field",
      })
    }
  })

export type AISegmentImageSchema = z.infer<typeof aiSegmentImageSchema>

export const aiSegmentImageDefaultFn = (
  props: Partial<AISegmentImageSchema> = {},
): AISegmentImageSchema => ({
  id: createId(),
  inputFieldId: "",
  target: "",
  matchSelection: aiSegmentImageMatchSelection.enum.largest,
  outputFormat: aiSegmentImageOutputFormat.enum.cutout,
  outputFieldId: "",
  ...props,
  stepType: stepTypes.enum.aiSegmentImage,
  states: [
    successStateDefaultFn(),
    skipStateDefaultFn(),
    errorStateDefaultFn(),
  ],
})
