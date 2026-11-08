import { PgDialect } from "drizzle-orm/pg-core"
import { expect, test, vi } from "vitest"
import { ShardedMessageRepository } from "../src/sharding/message/repository/sharded-message-repository"

vi.mock("@chatbotx.io/redis", () => ({
  withCache: (_key: string, factory: () => unknown) => factory(),
  invalidateCacheByTags: vi.fn(),
  distributedLock: { runExclusive: vi.fn() },
}))
const shard = (id: string) => ({
  id,
  shard: { id },
  startTime: new Date(0),
  endTime: null,
})
function setup(count = 2, rows: unknown[] = [{ id: "message" }]) {
  const predicates: unknown[] = []
  const query = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  }
  query.select.mockReturnValue(query)
  query.from.mockReturnValue(query)
  query.where.mockImplementation((condition) => {
    predicates.push(condition)
    return query
  })
  query.limit.mockResolvedValue(rows)
  const manager = {
    getShardsForTimeRange: vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: count }, (_, i) => shard(String(i))),
      ),
    getWriteShardInfo: vi.fn().mockResolvedValue(shard("write")),
    withShardClientForRead: vi.fn(async (_s, read) => await read(query)),
  }
  return {
    repo: new ShardedMessageRepository(manager as never),
    manager,
    query,
    predicates,
  }
}
test("all retained plus write shards, always workspace/source scoped", async () => {
  const { repo, manager, query, predicates } = setup()
  const results = await repo.findStatusCandidates({
    workspaceId: "ws",
    sourceId: "job",
  })
  expect(results).toHaveLength(3)
  expect(manager.withShardClientForRead).toHaveBeenCalledTimes(3)
  expect(query.limit).toHaveBeenCalledWith(65)
  for (const predicate of predicates) {
    const sql = new PgDialect().sqlToQuery(predicate as never)
    expect(sql.sql).toContain('"workspaceId"')
    expect(sql.sql).toContain('"sourceId"')
    expect(sql.params).toEqual(["ws", "job"])
  }
})
test("a failed shard cannot become a successful empty or partial lookup", async () => {
  const { repo, manager } = setup()
  manager.withShardClientForRead.mockRejectedValueOnce(new Error("offline"))
  await expect(
    repo.findStatusCandidates({ workspaceId: "ws", sourceId: "job" }),
  ).rejects.toThrow("offline")
})
test("bounded shard and candidate overflow fail closed", async () => {
  const manyShards = setup(65)
  await expect(
    manyShards.repo.findStatusCandidates({
      workspaceId: "ws",
      sourceId: "job",
    }),
  ).rejects.toThrow("api_status_owner_limit")
  expect(manyShards.manager.withShardClientForRead).not.toHaveBeenCalled()
  const manyRows = setup(
    1,
    Array.from({ length: 65 }, () => ({})),
  )
  await expect(
    manyRows.repo.findStatusCandidates({ workspaceId: "ws", sourceId: "job" }),
  ).rejects.toThrow("api_status_owner_limit")
})
