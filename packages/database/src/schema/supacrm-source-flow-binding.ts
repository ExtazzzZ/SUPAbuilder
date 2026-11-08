import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { flowModel } from "./flow"
import { workspaceModel } from "./workspace"

export const supacrmSourceFlowPolicy = pgEnum("supacrmSourceFlowPolicy", [
  "source_only_v1",
])

/** Неизменяемая принадлежность Flow; содержимое source и права браузера не хранятся. */
export const supacrmSourceFlowBindingModel = pgTable(
  "SupacrmSourceFlowBinding",
  {
    ...sharedColumns,
    flowId: bigintAsString().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    registryId: uuid().notNull(),
    bindingVersion: integer().notNull(),
    policy: supacrmSourceFlowPolicy().notNull(),
    authorizationId: uuid().notNull(),
    actorDigest: text().notNull(),
    policyDigest: text().notNull(),
  },
  (table) => [
    // Целевой Flow требует UNIQUE(id, workspaceId) в интеграционной миграции.
    foreignKey({
      name: "SupacrmSourceFlowBinding_flow_workspace_fk",
      columns: [table.flowId, table.workspaceId],
      foreignColumns: [flowModel.id, flowModel.workspaceId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("SupacrmSourceFlowBinding_flowId_key").on(table.flowId),
    uniqueIndex("SupacrmSourceFlowBinding_registryId_key").on(table.registryId),
    uniqueIndex("SupacrmSourceFlowBinding_authorizationId_key").on(
      table.authorizationId,
    ),
    index("SupacrmSourceFlowBinding_workspaceId_idx").on(table.workspaceId),
    check(
      "SupacrmSourceFlowBinding_version_check",
      sql`${table.bindingVersion} = 1`,
    ),
    check(
      "SupacrmSourceFlowBinding_actor_check",
      sql`${table.actorDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "SupacrmSourceFlowBinding_policy_check",
      sql`${table.policyDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
)
