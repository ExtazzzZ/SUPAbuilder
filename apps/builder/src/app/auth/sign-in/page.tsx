import { getSupaLoginConfig } from "@chatbotx.io/auth/supalogin"
import { SignInForm } from "@/features/auth/sign-in"
import { SupaLoginSignIn } from "@/features/auth/supalogin-sign-in"
import { resolveAuthPageOptions } from "@/lib/auth/auth-page-options"

export const dynamic = "force-dynamic"

export default async function SignInPage() {
  if (getSupaLoginConfig()) {
    return <SupaLoginSignIn />
  }
  const options = await resolveAuthPageOptions()

  return <SignInForm {...options} />
}
