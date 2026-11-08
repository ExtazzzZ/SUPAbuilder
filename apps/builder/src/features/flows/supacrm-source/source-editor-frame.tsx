"use client"

import { useMemo } from "react"
import { ConnectedSupacrmSourceEditor } from "./connected-editor"
import { MessageFieldHttpClient } from "./message-authoring/message-field-http"
import { createParentAuthoringFetch } from "./parent-transport"
import { SourceAuthoringClient } from "./source-client"

/** Виртуальный UUID используется только API-shaped adapter; parent сам привязан к настоящему боту. */
const parentBoundBotId = "00000000-0000-4000-8000-000000000000"

export function SourceEditorFrame({ crmOrigin }: { crmOrigin: string }) {
  const clients = useMemo(() => {
    const request = createParentAuthoringFetch(crmOrigin)
    return {
      authoring: new SourceAuthoringClient(request),
      message: new MessageFieldHttpClient(request),
    }
  }, [crmOrigin])
  return (
    <main className="mx-auto max-w-5xl p-6">
      <ConnectedSupacrmSourceEditor
        botId={parentBoundBotId}
        client={clients.authoring}
        messageClient={clients.message}
      />
    </main>
  )
}
