import { ChatbotXException } from "../errors"

/** The template an installation came from was deleted or never existed. */
export const templateSourceMissingException = () =>
  new ChatbotXException(
    "The source template for this installation is no longer available",
    "templateInstallationSourceMissing",
  )
