"use client"

import type { SourceAuthoringEnvelopeV1 } from "@chatbotx.io/flow-config"
import { createContext, type ReactNode, useContext } from "react"
import type { MessageFieldControllerProps } from "../message-authoring/message-field-controller"
import type { NativeSourceBinding } from "./types"

/** Авторитетное состояние выбранного source-поля, отдельное от legacy Flow form. */
export interface NativeSourcePropertyState {
  binding: NativeSourceBinding
  diagnosticCode?: string
  envelope?: SourceAuthoringEnvelopeV1
  messageEditor?: Omit<
    MessageFieldControllerProps,
    "label" | "labels" | "formComponent" | "renderReload"
  >
  status: "loading" | "ready" | "readonly" | "error"
}
const NativeSourcePropertyContext =
  createContext<NativeSourcePropertyState | null>(null)
export function NativeSourcePropertyProvider({
  value,
  children,
}: {
  value: NativeSourcePropertyState
  children: ReactNode
}) {
  return (
    <NativeSourcePropertyContext.Provider value={value}>
      {children}
    </NativeSourcePropertyContext.Provider>
  )
}
export function useNativeSourceProperty(): NativeSourcePropertyState | null {
  return useContext(NativeSourcePropertyContext)
}
