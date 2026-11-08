import { expect, test } from "vitest"
import { isPublicRoute } from "../src/lib/public-routes"

test("публична только точная оболочка source editor, соседние и вложенные routes закрыты", () => {
  expect(isPublicRoute("/supacrm/source-editor")).toBe(true)
  expect(isPublicRoute("/supacrm/source-editor/admin")).toBe(false)
  expect(isPublicRoute("/supacrm/source-editor-copy")).toBe(false)
  expect(isPublicRoute("/supacrm")).toBe(false)
})
