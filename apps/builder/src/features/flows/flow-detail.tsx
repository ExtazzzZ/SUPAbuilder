"use client"

import { ReactFlowProvider } from "@xyflow/react"
import { useMemo, useState } from "react"
import { AppointmentCalendarStoreProvider } from "@/features/appointment-calendars/provider/appointment-calendar-store-context"
import { PlatformCredentialsStoreProvider } from "@/features/platform-credentials/provider/platform-credentials-store-context"
import { QuestionnaireStoreProvider } from "@/features/questionnaires/provider/questionnaire-store-context"
import type { NativeSourceBinding } from "@/lib/source-authoring-native/authorization"
import { AIToolsStoreProvider } from "../ai-tools/provider/ai-tools-store-context"
import { EmailTopicStoreProvider } from "../email-topics/provider/email-topic-store-context"
import type { FlowVersionResource } from "../flow-versions/schema/resource"
import type { IntegrationOpenaiCompatibleResource } from "../integration-openai-compatible/schema/resource"
import { ReactFlowFrame } from "./react-flow/frame"
import { FlowTemplateStoreProvider } from "./react-flow/stores/flow-template-store-provider"
import { StepStoreProvider } from "./react-flow/stores/step-store-provider"
import { WhatsappFlowStoreProvider } from "./react-flow/stores/whatsapp-flow-store-provider"
import type { FlowResource, FlowWithVersionsResource } from "./schema/resource"
import { nativeSourceBindingIdentity } from "./supacrm-source/native/binding-identity"
import { createNativeSourceBrowserPort } from "./supacrm-source/native/document-port"

type FlowDetailProps = {
  flow: FlowWithVersionsResource
  flowVersion: FlowVersionResource
  openaiCompatibleIntegrations: IntegrationOpenaiCompatibleResource[]
  canRevertToPublished: boolean
  hasPublishedVersion: boolean
}

type SourceFlowDetailProps = {
  flow: FlowResource
  sourceBinding: NativeSourceBinding
}

export function FlowDetail(props: FlowDetailProps | SourceFlowDetailProps) {
  return "sourceBinding" in props ? (
    <SourceFlowDetail
      key={nativeSourceBindingIdentity(props.sourceBinding)}
      {...props}
    />
  ) : (
    <LegacyFlowDetail {...props} />
  )
}

function SourceFlowDetail({
  flow,
  sourceBinding: initialBinding,
}: SourceFlowDetailProps) {
  const [sourceBinding] = useState(initialBinding)
  const port = useMemo(() => {
    try {
      return createNativeSourceBrowserPort(sourceBinding)
    } catch {
      return null
    }
  }, [sourceBinding])
  return (
    <ReactFlowProvider>
      <StepStoreProvider initialState={{ activeFlowId: flow.id }}>
        <ReactFlowFrame
          flow={flow}
          sourceBinding={sourceBinding}
          sourcePort={port}
        />
      </StepStoreProvider>
    </ReactFlowProvider>
  )
}

function LegacyFlowDetail({
  flow,
  flowVersion,
  openaiCompatibleIntegrations,
  canRevertToPublished,
  hasPublishedVersion,
}: FlowDetailProps) {
  return (
    <ReactFlowProvider>
      <StepStoreProvider
        initialState={{
          activeFlowId: flow.id,
        }}
      >
        <FlowTemplateStoreProvider
          openaiCompatibleIntegrations={openaiCompatibleIntegrations}
          workspaceId={flow.workspaceId}
        >
          <WhatsappFlowStoreProvider workspaceId={flow.workspaceId}>
            <QuestionnaireStoreProvider workspaceId={flow.workspaceId}>
              <AppointmentCalendarStoreProvider workspaceId={flow.workspaceId}>
                <EmailTopicStoreProvider workspaceId={flow.workspaceId}>
                  <AIToolsStoreProvider workspaceId={flow.workspaceId}>
                    <PlatformCredentialsStoreProvider>
                      <ReactFlowFrame
                        canRevertToPublished={canRevertToPublished}
                        flow={flow}
                        flowVersion={flowVersion}
                        hasPublishedVersion={hasPublishedVersion}
                      />
                    </PlatformCredentialsStoreProvider>
                  </AIToolsStoreProvider>
                </EmailTopicStoreProvider>
              </AppointmentCalendarStoreProvider>
            </QuestionnaireStoreProvider>
          </WhatsappFlowStoreProvider>
        </FlowTemplateStoreProvider>
      </StepStoreProvider>
    </ReactFlowProvider>
  )
}
