import { flowService } from "@chatbotx.io/business"
import { notFound } from "next/navigation"
import { FlowDetail } from "@/features/flows/flow-detail"
import { isSameContent } from "@/features/flows/flow-version-content"
import { listIntegrationOpenaiCompatible } from "@/features/integration-openai-compatible/queries"
import { withWorkspaceIdAndIdSchema } from "@/features/workspaces/schema/resource"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { isNotFoundException } from "@/lib/errors/validation-exception"
import { resolveNativeSourceDocument } from "@/lib/source-authoring-native/server"

type FlowPageProps = {
  params: Promise<{ workspaceId: string; id: string }>
}

export default async function FlowPage({ params }: FlowPageProps) {
  const { data } = await withWorkspaceIdAndIdSchema.safeParse(await params)
  if (!data) {
    return notFound()
  }

  await requireWorkspacePermission(data.workspaceId, "flows")

  let flow: Awaited<ReturnType<typeof flowService.findById>>
  try {
    flow = await flowService.findById({
      id: data.id,
      workspaceId: data.workspaceId,
    })
  } catch (error) {
    if (isNotFoundException(error)) {
      return notFound()
    }
    throw error
  }

  const document = await resolveNativeSourceDocument({
    workspaceId: data.workspaceId,
    flowId: data.id,
  })
  if (document.kind === "blocked") {
    return notFound()
  }
  if (document.kind === "source") {
    const {
      id,
      workspaceId,
      name,
      active,
      enableInInbox,
      currentVersionId,
      draftVersionId,
      folderId,
      createdAt,
      updatedAt,
    } = flow
    return (
      <div className="flex h-screen w-screen flex-col">
        <FlowDetail
          flow={{
            id,
            workspaceId,
            name,
            active,
            enableInInbox,
            currentVersionId,
            draftVersionId,
            folderId,
            createdAt,
            updatedAt,
          }}
          sourceBinding={document}
        />
      </div>
    )
  }

  const draftFlowVersion = flow.flowVersions?.find((v) => v.isDraft)
  if (!draftFlowVersion) {
    return notFound()
  }

  const openaiCompatibleIntegrations = await listIntegrationOpenaiCompatible({
    workspaceId: data.workspaceId,
  })
  const publishedVersion = flow.flowVersions?.find(
    (v) => v.isLatest && !v.isDraft,
  )
  const hasPublishedVersion = publishedVersion !== undefined
  const canRevertToPublished =
    hasPublishedVersion &&
    !isSameContent(
      draftFlowVersion.nodes,
      draftFlowVersion.edges,
      publishedVersion.nodes,
      publishedVersion.edges,
    )

  return (
    <div className="flex h-screen w-screen flex-col">
      <FlowDetail
        canRevertToPublished={canRevertToPublished}
        flow={flow}
        flowVersion={draftFlowVersion}
        hasPublishedVersion={hasPublishedVersion}
        openaiCompatibleIntegrations={openaiCompatibleIntegrations}
      />
    </div>
  )
}
