import { notFound } from "next/navigation"
import { validateCrmOrigin } from "@/features/flows/supacrm-source/parent-transport"
import { SourceEditorFrame } from "@/features/flows/supacrm-source/source-editor-frame"

/** Пустая оболочка: значения и права management остаются в CRM parent. */
export default async function SourceEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ crmOrigin?: string | string[] }>
}) {
  const { crmOrigin } = await searchParams
  if (typeof crmOrigin !== "string") {
    return notFound()
  }
  try {
    validateCrmOrigin(crmOrigin)
  } catch {
    return notFound()
  }
  return <SourceEditorFrame crmOrigin={crmOrigin} />
}
