-- TemplateInstallation: install outbox (claim/lease), per-item lock provenance,
-- version pinning, publisher uninstall, actor kind.
ALTER TABLE "TemplateInstallation" ADD COLUMN "claimToken" text;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "claimedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "errorCode" text;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "sourceTemplateId" bigint;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "successfulInstallEvents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "sourceDeletedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "inboxBindings" jsonb;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "sourceVersion" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "lastSyncedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "publisherRef" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "publisherUninstallGrant" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "uninstalledAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "uninstalledByKind" text;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "uninstallCounts" jsonb;--> statement-breakpoint
ALTER TABLE "TemplateInstallation" ADD COLUMN "installedByKind" text DEFAULT 'apiToken' NOT NULL;--> statement-breakpoint
CREATE INDEX "TemplateInstallation_status_claimedAt_idx" ON "TemplateInstallation" ("status","claimedAt");--> statement-breakpoint
CREATE INDEX "TemplateInstallation_templateId_publisherRef_idx" ON "TemplateInstallation" ("templateId","publisherRef");--> statement-breakpoint
CREATE INDEX "TemplateInstallation_sourceTemplateId_idx" ON "TemplateInstallation" ("sourceTemplateId");--> statement-breakpoint
-- Backfill: provenance and the installs that already succeeded.
UPDATE "TemplateInstallation" SET "sourceTemplateId" = "templateId" WHERE "sourceTemplateId" IS NULL;--> statement-breakpoint
UPDATE "TemplateInstallation" SET "successfulInstallEvents" = 1 WHERE "status" IN ('completed', 'partial');--> statement-breakpoint
UPDATE "TemplateInstallation" AS i SET "sourceDeletedAt" = COALESCE(t."deletedAt", now()) FROM "Template" AS t WHERE t."id" = i."templateId" AND t."deletedAt" IS NOT NULL;--> statement-breakpoint
UPDATE "TemplateInstallation" SET "sourceDeletedAt" = now() WHERE "templateId" IS NULL AND "sourceDeletedAt" IS NULL;--> statement-breakpoint
-- Backfill: before this change the only way to create a TemplateInstallation
-- was the builder's install action, which always stored the installing
-- member's id; a workspace API token could not install. So every row that
-- exists when this runs belonged to a member (a null "installedBy" is a member
-- whose user was deleted later, FK ON DELETE SET NULL), never to a token.
-- Marking them all 'member' makes their automatic updates fail closed
-- (templateInstallerAccessLost) instead of running with full API-token power.
-- Rows created by token installs after this deploy carry 'apiToken' explicitly.
UPDATE "TemplateInstallation" SET "installedByKind" = 'member';--> statement-breakpoint
-- Backfill: one random reference per (template, target workspace) pair, so every
-- installation row of a pair shares it. Legacy installations get no uninstall
-- grant (the column default 0): the installer has to opt in.
UPDATE "TemplateInstallation" ti
SET "publisherRef" = pairs."ref"
FROM (
  SELECT "sourceTemplateId", "workspaceId",
         md5(random()::text || clock_timestamp()::text || "workspaceId"::text) AS "ref"
  FROM "TemplateInstallation"
  WHERE "sourceTemplateId" IS NOT NULL
  GROUP BY "sourceTemplateId", "workspaceId"
) pairs
WHERE ti."sourceTemplateId" = pairs."sourceTemplateId"
  AND ti."workspaceId" = pairs."workspaceId"
  AND ti."publisherRef" = '';--> statement-breakpoint
-- At most one in-flight install per (workspace, template): supersede older
-- duplicates, then enforce it.
UPDATE "TemplateInstallation" SET "status" = 'failed', "errorCode" = 'templateInstallSuperseded', "completedAt" = now() WHERE "status" IN ('pending', 'installing') AND "id" NOT IN (SELECT DISTINCT ON ("workspaceId", "sourceTemplateId") "id" FROM "TemplateInstallation" WHERE "status" IN ('pending', 'installing') ORDER BY "workspaceId", "sourceTemplateId", "createdAt" DESC, "id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "TemplateInstallation_workspaceId_sourceTemplateId_active_key" ON "TemplateInstallation" ("workspaceId","sourceTemplateId") WHERE "status" IN ('pending', 'installing');