import { getSupaLoginConfig } from "@chatbotx.io/auth/supalogin"
import { redirect } from "next/navigation"
import { SignUpForm } from "@/features/auth/sign-up"
import { resolveAuthPageOptions } from "@/lib/auth/auth-page-options"

export const dynamic = "force-dynamic"

export default async function SignUpPage() {
  if (getSupaLoginConfig()) {
    redirect("/auth/sign-in")
  }
  const options = await resolveAuthPageOptions()

  return <SignUpForm {...options} />
}
