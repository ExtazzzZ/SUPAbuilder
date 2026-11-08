"use client"

import { useQuery } from "@tanstack/react-query"
import { useWorkspaceId } from "@/hooks/routing"
import { orpc } from "@/lib/orpc/query"

export const useSupacrmCatalog = () => {
  const workspaceId = useWorkspaceId()
  return useQuery(
    orpc.flowsAPI.privateGetSupacrmCatalogAPI.queryOptions({
      input: { workspaceId },
      enabled: Boolean(workspaceId),
      staleTime: 0,
      refetchOnMount: "always",
    }),
  )
}

export const useSupacrmProductImage = (itemId: string, enabled: boolean) => {
  const workspaceId = useWorkspaceId()
  return useQuery(
    orpc.flowsAPI.privateGetSupacrmProductImageAPI.queryOptions({
      input: { workspaceId, itemId },
      enabled: Boolean(workspaceId && itemId && enabled),
      staleTime: 60_000,
    }),
  )
}
