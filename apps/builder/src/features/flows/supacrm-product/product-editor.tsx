"use client"

import {
  getSupacrmProduct,
  type SendMessageNodeSchema,
  selectSupacrmProduct,
  withSupacrmTariffSelection,
} from "@chatbotx.io/flow-config"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useReactFlow } from "@xyflow/react"
import { RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { useFlowHistory } from "../react-flow/stores/use-flow-history"
import { SupacrmProductSummary } from "./product-summary"
import { useSupacrmCatalog } from "./use-supacrm-catalog"

export function SupacrmProductEditor({
  nodeId,
  nodeDetails,
}: {
  nodeId: string
  nodeDetails: SendMessageNodeSchema["data"]["details"]
}) {
  const t = useTranslations()
  const { getNode, updateNodeData } = useReactFlow()
  const { takeSnapshot } = useFlowHistory()
  const query = useSupacrmCatalog()
  const [search, setSearch] = useState("")
  const [selectTariff, setSelectTariff] = useState(
    Boolean(getSupacrmProduct(nodeDetails)?.selectTariff),
  )
  const items = (query.data?.items ?? []).filter((item) =>
    `${item.title} ${item.id}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  )
  const [selected, setSelected] = useState(
    getSupacrmProduct(nodeDetails)?.catalogItemId ?? "",
  )
  const onSelect = (id: unknown) => {
    if (
      typeof id !== "string" ||
      !id ||
      !query.data?.items.some((item) => item.id === id)
    ) {
      return
    }
    const current = getNode(nodeId) as SendMessageNodeSchema | undefined
    if (!current) {
      return
    }
    takeSnapshot()
    const compiled = selectSupacrmProduct(current, id)
    updateNodeData(nodeId, { ...compiled.data })
    setSelected(id)
  }
  const status = query.isError ? "unavailable" : query.data?.status
  return (
    <div className="flex flex-col gap-4">
      {query.data?.provider === "isolated_fixture" && (
        <p className="text-muted-foreground text-sm">
          {t("supacrmProduct.isolatedFixture")}
        </p>
      )}
      <Label htmlFor={`product-${nodeId}`}>{t("supacrmProduct.label")}</Label>
      <input
        aria-label={t("supacrmProduct.search")}
        className="rounded-md border p-2"
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("supacrmProduct.search")}
        type="search"
        value={search}
      />
      <Select onValueChange={onSelect} value={selected || null}>
        <SelectTrigger
          className="w-full"
          disabled={query.isPending || status !== "ok"}
          id={`product-${nodeId}`}
        >
          <SelectValue placeholder={t("supacrmProduct.choose")}>
            {query.data?.items.find((item) => item.id === selected)?.title ??
              t("supacrmProduct.choose")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.title} · {t(`supacrmProduct.${item.availability}`)}
            </SelectItem>
          ))}
          {items.length === 0 && (
            <p className="p-2 text-sm">{t("supacrmProduct.noResults")}</p>
          )}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-2 text-sm">
        <input
          checked={selectTariff}
          onChange={(event) => {
            const current = getNode(nodeId) as SendMessageNodeSchema | undefined
            if (!current) {
              return
            }
            takeSnapshot()
            const compiled = withSupacrmTariffSelection(
              current,
              event.target.checked,
              [t("supacrmProduct.tariffSelected"), t("supacrmProduct.cancel")],
            )
            updateNodeData(nodeId, { ...compiled.data })
            setSelectTariff(event.target.checked)
          }}
          type="checkbox"
        />
        {t("supacrmProduct.selectTariff")}
      </label>
      <Button
        disabled={query.isFetching}
        onClick={() => query.refetch()}
        type="button"
        variant="outline"
      >
        <RefreshCwIcon />
        {t("supacrmProduct.refresh")}
      </Button>
      {status === "not_configured" && (
        <p className="text-muted-foreground text-sm">
          {t("supacrmProduct.notConfigured")}
        </p>
      )}
      {status === "unavailable" && (
        <p className="text-destructive text-sm">
          {t("supacrmProduct.unavailable")}
        </p>
      )}
      <SupacrmProductSummary catalogItemId={selected} />
      <p className="text-muted-foreground text-sm">
        {t("supacrmProduct.description")}
      </p>
    </div>
  )
}
