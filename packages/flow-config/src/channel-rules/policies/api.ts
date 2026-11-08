import { stepTypes } from "../../steps/step-action"
import { defineChannelFlowPolicy } from "./define"
// API messages use the platform's 6,000-character transport limit.

export const apiFlowPolicy = defineChannelFlowPolicy({
  limits: {
    buttonCount: 3,
    buttonLabel: 80,
    text: 6000,
  },
  supported: [
    stepTypes.enum.sendText,
    stepTypes.enum.sendImage,
    stepTypes.enum.sendMultipleImages,
    stepTypes.enum.sendCarousel,
    stepTypes.enum.sendVideo,
    stepTypes.enum.sendGif,
    stepTypes.enum.sendAudio,
    stepTypes.enum.sendFile,
    stepTypes.enum.sendQuickReply,
  ],
  // API-мост сохраняет кнопки текста и одиночного изображения.
  noButtons: [
    stepTypes.enum.sendVideo,
    stepTypes.enum.sendAudio,
    stepTypes.enum.sendFile,
  ],
})
