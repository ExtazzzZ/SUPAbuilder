import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { useTranslations } from "next-intl"
import { MediaLibraryOrInsertLink } from "@/components/media-library-or-insert-link"
import { ButtonGroupEditor } from "../button/editor"
import { MediaStepNotice } from "../button/media-step-notice"

type SendImageStepEditorProps = {
  parentName: string
}

const SendImageStepEditor = ({ parentName }: SendImageStepEditorProps) => {
  const t = useTranslations()
  return (
    <div className="items-center justify-center overflow-hidden rounded-lg">
      <div className="bg-secondary px-4 py-2">
        <MediaLibraryOrInsertLink fileType="image" parentName={parentName} />
        <TextareaField
          label={t("flows.imageCaption.label")}
          name={`${parentName}.caption`}
        />
        <SelectField
          label={t("flows.imageCaption.format")}
          name={`${parentName}.textFormat`}
          options={[
            { value: "plain", label: t("flows.imageCaption.plain") },
            { value: "html", label: t("flows.imageCaption.html") },
          ]}
          placeholder={t("flows.imageCaption.plain")}
        />
      </div>
      <div className="bg-slate-200 px-3 py-2 dark:bg-neutral-900">
        <ButtonGroupEditor parentName={`${parentName}.buttons`} />
        <MediaStepNotice parentName={parentName} />
      </div>
    </div>
  )
}

export default SendImageStepEditor
