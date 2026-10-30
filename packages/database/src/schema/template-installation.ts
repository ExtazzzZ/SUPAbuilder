import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import {
  type TemplateActorKind,
  type TemplateInstallationStatus,
  type TemplatePermissions,
  type TemplateUninstallCounts,
  type TemplateUninstallRequester,
  type TemplateWarning,
  templateInstallationStatuses,
} from "../partials/template"
import { userModel } from "./auth-user"
import { folderModel } from "./folder"
import { templateModel } from "./template"
import { workspaceModel } from "./workspace"

export const templateInstallationStatus = pgEnum(
  "templateInstallationStatus",
  templateInstallationStatuses.options as [
    TemplateInstallationStatus,
    ...TemplateInstallationStatus[],
  ],
)

/**
 * The install job header AND progress row — the only status surface for a
 * share-link install. `templateId` is `set null` (not cascade): provenance
 * must outlive the author deleting the template, or `allowDelete`
 * enforcement silently loses its rule. `sourceWorkspaceId` is a plain bigint
 * with no FK — it spans tenants and is never dereferenced during install.
 */
export const templateInstallationModel = pgTable(
  "TemplateInstallation",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    templateId: bigintAsString().references(() => templateModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    // Denormalized so the row still reads clearly after the template (or its
    // name) changes or is deleted.
    templateName: text().notNull(),
    sourceWorkspaceId: bigintAsString().notNull(),
    formatVersion: integer().notNull(),
    status: templateInstallationStatus().notNull().default("pending"),
    permissions: jsonb().$type<TemplatePermissions>().notNull(),
    warnings: jsonb().$type<TemplateWarning[]>().default([]).notNull(),
    warningCount: integer().default(0).notNull(),
    errorMessage: text(),
    resourceCount: integer().default(0).notNull(),
    // The root folder this install's resources were nested under, when the
    // source template has `createInstallFolder` enabled. `set null` (not
    // cascade) so a workspace admin deleting the folder later doesn't cascade
    // into deleting this tracking row.
    installFolderId: bigintAsString().references(() => folderModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    // Copied from `Template.defaultAutoUpdate` at install time; the
    // installer can flip it afterward independent of the publisher's
    // template-wide default.
    autoUpdate: boolean().default(false).notNull(),
    // `Template.updatedAt` at the moment this installation was created —
    // compared against the live `Template.updatedAt` to derive
    // "update available" without a separate version counter.
    sourceUpdatedAt: timestamp(timestampConfig),
    installedBy: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    // Persisted so a member whose user row is later deleted (`installedBy`
    // set null) reads as lost access, not as an API token with full power.
    installedByKind: text()
      .$type<TemplateActorKind>()
      .default("apiToken")
      .notNull(),
    completedAt: timestamp(timestampConfig),
    // Durable-dispatch fields (the `InboundWebhookRequest` outbox pattern):
    // the worker claims the row with `claimToken`/`claimedAt` as a lease, so
    // a redelivered or swept job is a no-op unless the lease expired.
    claimToken: text(),
    claimedAt: timestamp(timestampConfig),
    attempts: integer().default(0).notNull(),
    // Machine-readable failure code; the raw `errorMessage` never reaches
    // the client.
    errorCode: text(),
    // Immutable provenance — unlike `templateId` it is never nulled, so the
    // sweep and install-count grouping survive the template being deleted.
    sourceTemplateId: bigintAsString(),
    // Counts install and reinstall completions (auto/manual syncs excluded);
    // the "Installs" figure sums it over active installations only.
    successfulInstallEvents: integer().default(0).notNull(),
    // Set when the source template is deleted: the copies stop being governed
    // by it, so its locks no longer apply.
    sourceDeletedAt: timestamp(timestampConfig),
    // The installer's choice of target inbox for each inbox the template was
    // built around: `{ sourceInboxId: targetInboxId }`. Validated when the
    // install is requested and applied by the worker; null when none.
    inboxBindings: jsonb().$type<Record<string, string>>(),
    // The `TemplateVersion` this installation last fully applied (the one an
    // install reads its payload from), and when a sync last finished.
    // Opaque, random reference to this (template, target workspace) pair,
    // shared by every installation row of the pair. The publisher lists and
    // addresses installers by it; it reveals no workspace or row id.
    publisherRef: text().default("").notNull(),
    // The disclosure version the installer accepted ("the publisher sees this
    // workspace's name and can uninstall the template"); 0 = not granted.
    publisherUninstallGrant: smallint().default(0).notNull(),
    // Set when the installation was uninstalled: by whom, when, and what became of its copies.
    uninstalledAt: timestamp(timestampConfig),
    uninstalledByKind: text().$type<TemplateUninstallRequester>(),
    uninstallCounts: jsonb().$type<TemplateUninstallCounts>(),
    sourceVersion: integer().default(1).notNull(),
    lastSyncedAt: timestamp(timestampConfig),
  },
  (table) => [
    index("TemplateInstallation_workspaceId_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
    ),
    index("TemplateInstallation_templateId_idx").using(
      "btree",
      table.templateId.asc().nullsLast(),
    ),
    index("TemplateInstallation_workspaceId_status_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    // At most one in-flight install per (workspace, source template): a double
    // click or a replayed request can never queue two copies at once.
    uniqueIndex("TemplateInstallation_workspaceId_sourceTemplateId_active_key")
      .using(
        "btree",
        table.workspaceId.asc().nullsLast(),
        table.sourceTemplateId.asc().nullsLast(),
      )
      .where(sql`${table.status} IN ('pending', 'installing')`),
    // Hot paths filter by the source template alone: the update fan-out and
    // its sweep, the version prune, and marking a deleted source.
    index("TemplateInstallation_sourceTemplateId_idx").using(
      "btree",
      table.sourceTemplateId.asc().nullsLast(),
    ),
    index("TemplateInstallation_templateId_publisherRef_idx").using(
      "btree",
      table.templateId.asc().nullsLast(),
      table.publisherRef.asc().nullsLast(),
    ),
    // Sweep scan: stale `pending` rows and expired `installing` leases.
    index("TemplateInstallation_status_claimedAt_idx").using(
      "btree",
      table.status.asc().nullsLast(),
      table.claimedAt.asc().nullsLast(),
    ),
  ],
)
