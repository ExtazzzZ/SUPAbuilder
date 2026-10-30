-- Template resource categories + the uninstalled installation status.
-- NOTE: PostgreSQL cannot remove an enum value, so this migration is not reversible by a rollback; a rolled-back app version simply ignores the extra values. Deploy readers and workers before writers.
ALTER TYPE "templateResourceCategory" ADD VALUE 'sequences' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateResourceCategory" ADD VALUE 'aiMcpServers' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateResourceCategory" ADD VALUE 'aiFiles' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateResourceCategory" ADD VALUE 'questionnaires' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateResourceCategory" ADD VALUE 'couponTopics' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateResourceCategory" ADD VALUE 'pipelines' BEFORE 'customFields';--> statement-breakpoint
ALTER TYPE "templateInstallationStatus" ADD VALUE 'uninstalled';