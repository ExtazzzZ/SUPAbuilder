CREATE TYPE "supacrmSourceFlowPolicy" AS ENUM('source_only_v1');--> statement-breakpoint
CREATE TABLE "SupacrmSourceFlowBinding" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"flowId" bigint NOT NULL,
	"workspaceId" bigint NOT NULL,
	"registryId" uuid NOT NULL,
	"bindingVersion" integer NOT NULL,
	"policy" "supacrmSourceFlowPolicy" NOT NULL,
	"authorizationId" uuid NOT NULL,
	"actorDigest" text NOT NULL,
	"policyDigest" text NOT NULL,
	CONSTRAINT "SupacrmSourceFlowBinding_version_check" CHECK ("bindingVersion" = 1),
	CONSTRAINT "SupacrmSourceFlowBinding_actor_check" CHECK ("actorDigest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "SupacrmSourceFlowBinding_policy_check" CHECK ("policyDigest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "Flow_id_workspaceId_key" ON "Flow" ("id","workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "SupacrmSourceFlowBinding_flowId_key" ON "SupacrmSourceFlowBinding" ("flowId");--> statement-breakpoint
CREATE UNIQUE INDEX "SupacrmSourceFlowBinding_registryId_key" ON "SupacrmSourceFlowBinding" ("registryId");--> statement-breakpoint
CREATE UNIQUE INDEX "SupacrmSourceFlowBinding_authorizationId_key" ON "SupacrmSourceFlowBinding" ("authorizationId");--> statement-breakpoint
CREATE INDEX "SupacrmSourceFlowBinding_workspaceId_idx" ON "SupacrmSourceFlowBinding" ("workspaceId");--> statement-breakpoint
ALTER TABLE "SupacrmSourceFlowBinding" ADD CONSTRAINT "SupacrmSourceFlowBinding_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;--> statement-breakpoint
ALTER TABLE "SupacrmSourceFlowBinding" ADD CONSTRAINT "SupacrmSourceFlowBinding_flow_workspace_fk" FOREIGN KEY ("flowId","workspaceId") REFERENCES "Flow"("id","workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;