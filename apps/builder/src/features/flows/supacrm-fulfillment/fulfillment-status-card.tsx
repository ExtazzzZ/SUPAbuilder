"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { z } from "zod"
import { orpc } from "@/lib/orpc/query"

const anchor = z.object({
  crmFulfillmentExecution: z.strictObject({
    flowId: z.string().regex(/^\d+$/),
    fulfillmentRef: z.uuid(),
  }),
})
const states = [
  "pending",
  "waiting",
  "sending",
  "processing",
  "completed",
  "refunded",
  "rejected",
  "prepared",
  "sent",
  "unknown",
  "review",
  "needs_review",
  "failed",
  "cancelled",
  "not_prepared",
] as const

/** Ref discovery follows stored CRM terminal events; it is never an input field. */
export function FulfillmentStatusCard({
  attributes,
  workspaceId,
}: {
  attributes: unknown
  workspaceId: string
}) {
  const parsed = anchor.safeParse(attributes)
  if (!(parsed.success && workspaceId)) {
    return null
  }
  const execution = parsed.data.crmFulfillmentExecution
  return (
    <OwnedExecutionStatus
      key={`${workspaceId}:${execution.flowId}:${execution.fulfillmentRef}`}
      workspaceId={workspaceId}
      {...execution}
    />
  )
}
function OwnedExecutionStatus(input: {
  workspaceId: string
  flowId: string
  fulfillmentRef: string
}) {
  const t = useTranslations("supacrmFulfillment.status")
  const [opened, setOpened] = useState(false)
  const query = useQuery(
    orpc.flowsAPI.fulfillmentStatus.queryOptions({
      input,
      enabled: opened,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
    }),
  )
  const result = query.isError ? undefined : query.data
  const stateLabel = (value: string) =>
    t(`states.${states.find((state) => state === value) ?? "unknown"}`)
  return (
    <section aria-label={t("title")} className="rounded-md border p-3 text-sm">
      <p>{t("source")}</p>
      <Button
        disabled={query.isFetching}
        onClick={async () => {
          if (opened) {
            await query.refetch()
          } else {
            setOpened(true)
          }
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {t(opened ? "refresh" : "open")}
      </Button>
      {opened && query.isPending && <p role="status">{t("loading")}</p>}
      {query.isError && <p role="alert">{t("unavailable")}</p>}
      {result && (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <dt>{t("purchase")}</dt>
            <dd>{stateLabel(result.purchaseStatus)}</dd>
            <dt>{t("delivery")}</dt>
            <dd>{stateLabel(result.deliveryStatus)}</dd>
            <dt>{t("native")}</dt>
            <dd>{stateLabel(result.nativeStatus)}</dd>
            {(["author_instruction", "apple_code_reference"] as const).map(
              (key) => (
                <div className="contents" key={key}>
                  <dt>{t(key)}</dt>
                  <dd>
                    {stateLabel(
                      result.parts.find((part) => part.key === key)?.status ??
                        "not_prepared",
                    )}
                  </dd>
                </div>
              ),
            )}
          </dl>
          {result.errorCode && <p role="status">{t("reviewReason")}</p>}
        </>
      )}
    </section>
  )
}
