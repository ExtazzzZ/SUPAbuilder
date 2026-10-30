"use server"

import {
  isUserWorkspaceAllowed,
  workspaceMemberService,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import type {
  GetWorkspaceMemberRequest,
  GetWorkspaceMemberResponse,
  ListWorkspaceMembersRequest,
  ListWorkspaceMembersResponse,
} from "../schema/query"
import type { WorkspaceMemberResource } from "../schema/resource"

export async function listWorkspaceMembers(
  input: ListWorkspaceMembersRequest,
): Promise<ListWorkspaceMembersResponse> {
  if (!isUserWorkspaceAllowed(input.workspaceId)) {
    throw new ChatbotXException("Workspace not found", "notFound", 404)
  }
  return await workspaceMemberService.listPaginated(input)
}

export async function getWorkspaceMember(
  input: GetWorkspaceMemberRequest,
): Promise<GetWorkspaceMemberResponse | undefined> {
  if (!isUserWorkspaceAllowed(input.workspaceId)) {
    return
  }
  return await workspaceMemberService.findByIdWithUser({
    id: input.memberId,
    workspaceId: input.workspaceId,
  })
}

export const getAllWorkspaceMembers = async (userId: string) => {
  const memberships = await workspaceMemberService.listByUserIdUncached({
    userId,
  })
  const workspaceMembers = memberships.filter((member) =>
    isUserWorkspaceAllowed(member.workspaceId),
  )

  const workspaces = workspaceMembers.map((member) => member.workspace)

  const workspaceIds = Array.from(
    new Set(workspaces.map((workspace) => workspace.id)),
  )

  return {
    workspaceMembers: workspaceMembers as WorkspaceMemberResource[],
    workspaces,
    workspaceIds,
  }
}
