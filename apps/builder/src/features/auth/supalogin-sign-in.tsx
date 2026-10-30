"use client"

import { buttonVariants } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
} from "@chatbotx.io/ui/components/ui/card"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { OAuthErrorAlert } from "./components/oauth-error-alert"
import { AuthHeader } from "./components/shared"

/** Единственный способ входа в SUPAbuilder при подключённом SUPAlogin. */
export function SupaLoginSignIn() {
  const t = useTranslations()
  const search = useSearchParams()
  const callback = search.get("callbackURL")
  const href = `/api/auth/supalogin/start${callback ? `?callbackURL=${encodeURIComponent(callback)}` : ""}`
  return (
    <Card>
      <CardHeader className="text-center">
        <AuthHeader title={t("auth.signInTitle", { name: "SUPAbuilder" })} />
      </CardHeader>
      <CardContent className="grid gap-6">
        <OAuthErrorAlert />
        <a className={`w-full ${buttonVariants()}`} href={href}>
          {t("auth.continueWithProvider", { name: "SUPAlogin" })}
        </a>
      </CardContent>
    </Card>
  )
}
