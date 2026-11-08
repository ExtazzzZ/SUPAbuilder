import { bootstrapTestWorkspace } from "./test-bootstrap"

bootstrapTestWorkspace()
  .then((result) => {
    console.log(
      result.created
        ? `TEST workspace created: ${result.workspaceId}`
        : "TEST bootstrap skipped; existing data unchanged",
    )
    process.exit(0)
  })
  .catch(() => {
    console.error("TEST bootstrap failed; check configuration and database")
    process.exit(1)
  })
