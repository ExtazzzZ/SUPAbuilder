"use client"
import type { SupacrmCheckout } from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
export const checkoutTitleKeys = {
  promo: "supacrmCheckout.promo",
  bonus: "supacrmCheckout.bonus",
  referral_summary: "supacrmCheckout.referral_summary",
  offer: "supacrmCheckout.offer",
  receipt: "supacrmCheckout.receipt",
  link: "supacrmCheckout.link",
  wait: "supacrmCheckout.wait",
} as const
export function SupacrmCheckoutSummary({
  settings,
}: {
  settings: SupacrmCheckout
}) {
  const t = useTranslations()
  return (
    <div className="text-sm">
      <p className="font-medium">{t(checkoutTitleKeys[settings.kind])}</p>
      <p className="whitespace-pre-wrap text-muted-foreground">
        {settings.prompt}
      </p>
    </div>
  )
}
