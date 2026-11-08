import { authorizeNativeSourceRequest } from "@/lib/source-authoring-native/server"
import { forwardNativeSource } from "@/lib/source-authoring-native/transport"

type Context = {
  params: Promise<{ workspaceId: string; flowId: string; action: string[] }>
}

async function forward(request: Request, context: Context) {
  const { workspaceId, flowId, action } = await context.params
  return forwardNativeSource(
    request,
    { workspaceId, flowId },
    action.join("/"),
    {
      authorize: authorizeNativeSourceRequest,
      request: (input, init) => fetch(input, init),
      builderOrigin: process.env.NEXT_PUBLIC_BUILDER_URL ?? "",
      apiBase: process.env.SUPACRM_SOURCE_API_URL ?? "",
      apiKey: process.env.SUPACRM_SOURCE_API_KEY ?? "",
    },
  )
}

export const GET = forward
export const POST = forward
export const PATCH = forward
