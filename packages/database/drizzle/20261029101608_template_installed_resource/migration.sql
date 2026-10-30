-- TemplateInstalledResource: per-item View/Edit lock, detach marker, sync tracking.
-- (The dedupe + unique index is the separate non-transactional migration after
-- the sync tables.)
ALTER TABLE "TemplateInstalledResource" ADD COLUMN "allowEdit" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstalledResource" ADD COLUMN "allowDelete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "TemplateInstalledResource" ADD COLUMN "detachedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "TemplateInstalledResource" ADD COLUMN "syncedHash" text;--> statement-breakpoint
ALTER TABLE "TemplateInstalledResource" ADD COLUMN "syncedVersion" integer;--> statement-breakpoint
CREATE INDEX "TemplateInstalledResource_active_lookup_idx" ON "TemplateInstalledResource" ("workspaceId","resourceKind","resourceId") WHERE "wasExisting" = false AND "detachedAt" IS NULL;--> statement-breakpoint
UPDATE "TemplateInstalledResource" AS r SET "allowEdit" = COALESCE((i."permissions"->>'allowEdit')::boolean, true), "allowDelete" = COALESCE((i."permissions"->>'allowDelete')::boolean, true) FROM "TemplateInstallation" AS i WHERE i."id" = r."installationId" AND r."wasExisting" = false;