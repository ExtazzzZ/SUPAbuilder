import {
  type ButtonStepProps,
  buttonStepDefaultFn,
  CHANNEL_FLOW_POLICIES,
  getChannelFlowPolicy,
  groupButtonRows,
  resolveSendTextLengthLimits,
  setButtonRowPlacement,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Sortable,
  SortableItem,
  SortableItemHandle,
} from "@chatbotx.io/ui/components/ui/sortable"
import { GripVerticalIcon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { CharacterCounter } from "@/components/character-counter"
import type { ButtonEditorConfig } from "../../stores/step-store"
import { useStepStore } from "../../stores/step-store-provider"

type ButtonStepEditorProps = {
  parentName: string
  editorConfig?: ButtonEditorConfig
}

export const ButtonStepEditor = (props: ButtonStepEditorProps) => {
  const { parentName, editorConfig, ...rest } = props

  const { getValues, setValue } = useFormContext()
  const {
    setButtonPath,
    setButtonInitialData,
    setOpenButtonEditorDialog,
    setButtonEditorConfig,
  } = useStepStore((state) => state)

  const buttonData = getValues(`${parentName}`)
  // Watched, not read: the label is edited in a dialog elsewhere, so the
  // counter would otherwise keep showing the length from before that edit.
  const label = useWatch({ name: `${parentName}.label` })
  const channel = useWatch({ name: "beforeStep.channel" })
  const t = useTranslations()
  const groupPath = parentName.slice(0, parentName.lastIndexOf("."))
  const index = Number(parentName.slice(parentName.lastIndexOf(".") + 1))
  const watchedButtons = useWatch({ name: groupPath })
  const buttons: ButtonStepProps[] = Array.isArray(watchedButtons)
    ? watchedButtons
    : []
  const rows = groupButtonRows(buttons)
  const ownRow =
    rows.find((row) => row.some((button) => button === buttons[index])) ?? []
  const current = buttons[index]
  const joined = current ? ownRow.indexOf(current) > 0 : false
  const previousRow = rows[rows.indexOf(ownRow) - 1]
  const canJoin = index > 0 && (joined || previousRow?.length === 1)
  const supportsRows = channel === "api" || channel === "omnichannel"

  const limits = resolveSendTextLengthLimits({ channel })
  const labelMax = parentName.startsWith("quickReplies")
    ? limits.quickReplyLabel
    : limits.buttonLabel

  return (
    <div className="w-full min-w-0 flex-1" {...rest}>
      <Button
        className="w-full justify-between gap-2 hover:text-blue-500"
        onClick={() => {
          setButtonEditorConfig(editorConfig ?? null)
          setButtonPath(`data.details.${parentName}`)
          setButtonInitialData(buttonData)
          setOpenButtonEditorDialog(true)
        }}
        type="button"
        variant="secondary"
      >
        <span className="truncate">{label}</span>
        <CharacterCounter max={labelMax} value={label} />
      </Button>
      {supportsRows && index > 0 && (
        <Button
          aria-label={t("flows.buttons.placement", { label })}
          aria-pressed={joined}
          className="h-auto max-w-full whitespace-normal px-1 py-1 text-xs"
          disabled={!canJoin}
          onClick={() => {
            setValue(
              groupPath,
              setButtonRowPlacement(buttons, index, !joined),
              {
                shouldDirty: true,
                shouldValidate: true,
              },
            )
          }}
          type="button"
          variant="ghost"
        >
          {joined
            ? t("flows.buttons.fullRow")
            : t("flows.buttons.joinPrevious")}
        </Button>
      )}
    </div>
  )
}

type ButtonGroupEditorProps = {
  parentName: string
}

export const ButtonGroupEditor = (props: ButtonGroupEditorProps) => {
  const { parentName } = props
  const t = useTranslations()
  const { control } = useFormContext()
  const { fields, append, move } = useFieldArray({
    control,
    name: parentName,
  })
  const channel = useWatch({ name: "beforeStep.channel" })
  const buttons: ButtonStepProps[] = useWatch({ name: parentName }) ?? []

  const maxButtons =
    getChannelFlowPolicy(channel)?.limits.buttonCount ??
    CHANNEL_FLOW_POLICIES.omnichannel.limits.buttonCount

  function addButton() {
    append(
      buttonStepDefaultFn({
        label: `${t("fields.button.label")} #${fields.length + 1}`,
      }),
    )
  }

  return (
    <>
      <Sortable
        getItemValue={(item) => item.id}
        onMove={({ activeIndex, overIndex }) => move(activeIndex, overIndex)}
        value={fields}
      >
        <div className="grid w-full grid-cols-6 gap-2">
          {fields.map((field, index) => (
            <SortableItem
              key={field.id}
              render={
                <div
                  className="flex w-full items-center gap-1"
                  style={buttonGridStyle(buttons, index)}
                >
                  <ButtonStepEditor parentName={`${parentName}.${index}`} />
                  <SortableItemHandle
                    render={
                      <Button className="size-8" size="icon" variant="ghost">
                        <GripVerticalIcon className="h-4 w-4" />
                      </Button>
                    }
                  />
                </div>
              }
              value={field.id}
            />
          ))}
        </div>
      </Sortable>

      <Button
        className="my-1.5 w-full"
        disabled={fields.length >= maxButtons}
        onClick={addButton}
        type="button"
        variant="secondary"
      >
        <PlusIcon />
        {t("actions.add")}
      </Button>
      {fields.length >= maxButtons ? (
        <p className="text-muted-foreground text-sm">
          {t("flows.buttons.limitReached", { max: maxButtons })}
        </p>
      ) : null}
    </>
  )
}

/** Сетка делит строку поровну и сохраняет импортированные ряды из трёх кнопок. */
export const buttonGridStyle = (buttons: ButtonStepProps[], index: number) => {
  const row = groupButtonRows(buttons).find((items) =>
    items.some((button) => button === buttons[index]),
  )
  return {
    gridColumn: `span ${Math.max(1, Math.floor(6 / (row?.length ?? 1)))}`,
  }
}
