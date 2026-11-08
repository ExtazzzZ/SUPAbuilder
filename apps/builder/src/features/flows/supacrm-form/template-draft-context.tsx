"use client"

import type { ReceiptEmailTemplateBase } from "@chatbotx.io/flow-config"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react"
import type {
  ReceiptEmailTemplateDraftRequest,
  ReceiptEmailTemplateDraftResult,
} from "./template-draft"

type Run = (
  request: ReceiptEmailTemplateDraftRequest,
) => Promise<ReceiptEmailTemplateDraftResult>
const Context = createContext<{
  run: Run | null
  register: (run: Run | null) => void
  getAcknowledgedBase: () => ReceiptEmailTemplateBase | undefined
  registerAcknowledgedBase: (
    getter: (() => ReceiptEmailTemplateBase) | null,
  ) => void
}>({
  run: null,
  register: () => undefined,
  getAcknowledgedBase: () => undefined,
  registerAcknowledgedBase: () => undefined,
})
export function ReceiptEmailTemplateDraftProvider({
  children,
}: {
  children: ReactNode
}) {
  const [run, setRun] = useState<Run | null>(null)
  const register = useCallback((next: Run | null) => setRun(() => next), [])
  const getterRef = useRef<(() => ReceiptEmailTemplateBase) | null>(null)
  const getAcknowledgedBase = useCallback(() => getterRef.current?.(), [])
  const registerAcknowledgedBase = useCallback(
    (getter: (() => ReceiptEmailTemplateBase) | null) => {
      getterRef.current = getter
    },
    [],
  )
  const value = useMemo(
    () => ({ run, register, getAcknowledgedBase, registerAcknowledgedBase }),
    [run, register, getAcknowledgedBase, registerAcknowledgedBase],
  )
  return <Context value={value}>{children}</Context>
}
export const useReceiptEmailTemplateDraft = () => useContext(Context)
