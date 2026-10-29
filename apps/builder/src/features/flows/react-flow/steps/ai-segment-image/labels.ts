import type {
  AISegmentImageMatchSelection,
  AISegmentImageOutputFormat,
  StateType,
} from "@chatbotx.io/flow-config"

export const matchSelectionLabelKeys = {
  largest: "fields.aiSegmentImage.matchSelection.options.largest",
  all: "fields.aiSegmentImage.matchSelection.options.all",
} as const satisfies Record<AISegmentImageMatchSelection, string>

export const outputFormatLabelKeys = {
  cutout: "fields.aiSegmentImage.outputFormat.options.cutout",
  mask: "fields.aiSegmentImage.outputFormat.options.mask",
} as const satisfies Record<AISegmentImageOutputFormat, string>

export const stateLabelKeys = {
  success: "fields.aiSegmentImage.states.success",
  skip: "fields.aiSegmentImage.states.skip",
  error: "fields.aiSegmentImage.states.error",
} as const satisfies Record<StateType, string>
