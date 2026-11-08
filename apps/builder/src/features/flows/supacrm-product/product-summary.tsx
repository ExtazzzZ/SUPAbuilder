"use client"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { ShoppingBagIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useSupacrmCatalog,
  useSupacrmProductImage,
} from "./use-supacrm-catalog"

/** Название/изображение берутся из текущего каталога и никогда не записываются в граф. */
export function SupacrmProductSummary({
  catalogItemId,
}: {
  catalogItemId: string
}) {
  const t = useTranslations()
  const query = useSupacrmCatalog()
  const item = query.data?.items.find((row) => row.id === catalogItemId)
  const image = useSupacrmProductImage(catalogItemId, Boolean(item?.hasImage))
  let message = t("supacrmProduct.missing")
  if (!catalogItemId) {
    message = t("supacrmProduct.choose")
  } else if (query.isPending) {
    message = t("supacrmProduct.loading")
  } else if (query.isError || query.data?.status === "unavailable") {
    message = t("supacrmProduct.unavailable")
  } else if (query.data?.status === "not_configured") {
    message = t("supacrmProduct.notConfigured")
  }
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <Avatar className="size-12 rounded-md">
        {item && image.data?.dataUrl && (
          <AvatarImage alt={item.title} src={image.data.dataUrl} />
        )}
        <AvatarFallback>
          <ShoppingBagIcon className="size-5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 text-sm">
        <p className="break-words font-medium">{item?.title ?? message}</p>
        {item && (
          <p className="text-muted-foreground">
            {t(`supacrmProduct.${item.availability}`)}
          </p>
        )}
      </div>
    </div>
  )
}
