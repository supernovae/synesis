import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageWriter, type ConversationMemoryStats } from "../src/state/usage-writer.js";
import { SessionContinuityService } from "../src/context/session-continuity.js";
import { SessionStore, type SessionContinuity } from "../src/state/session-store.js";
import type { AppConfig } from "../src/config.js";

let lastEvalTtl: number | null = null;
vi.mock("ioredis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue("OK");
    eval = vi.fn((...args: unknown[]) => {
      lastEvalTtl = Number(args[5]);
      return Promise.resolve(1);
    });
    quit = vi.fn().mockResolvedValue(undefined);
  }
  return { Redis: MockRedis };
});

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
    get totalCount() { return 1; }
    get idleCount() { return 1; }
    get waitingCount() { return 0; }
  }
  return { Pool: MockPool };
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "",
    SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
    SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://fallback/v1",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "k",
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_YARN_DB_POOL_MAX: 5,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
    SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
    SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED: true,
    SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED: true,
    SYNESIS_YARN_RECALL_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  } as AppConfig;
}

function dummyContinuity(overrides: Partial<SessionContinuity> = {}): SessionContinuity {
  return {
    currentTask: "Fix auth bug in middleware",
    keyFindings: ["Token expiry was not checked", "Redis pool leak"],
    decisions: ["Use ioredis", "Switch to middleware pattern"],
    recentFiles: ["src/auth.ts", "src/config.ts"],
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("Conversation Memory — SessionStore configurable TTL", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    lastEvalTtl = null;
  });

  it("uses SYNESIS_YARN_SESSION_TTL_MS from config when no override", async () => {
    const store = new SessionStore(makeConfig({ SYNESIS_YARN_SESSION_TTL_MS: 7200000 }) as AppConfig);
    const record = {
      sessionKey: "k1", userId: "u1", orgId: "o1", conversationId: "c1",
      clientKind: "test", createdAt: Date.now(), lastActiveAt: Date.now(),
      totalTokensIn: 0, totalTokensOut: 0, totalTokensCached: 0, totalTokensSaved: 0,
      requestCount: 0, escalationCount: 0, consecutiveFailedVerifications: 0,
      metadata: {}, version: 0,
    };
    await store.save(record);
    expect(lastEvalTtl).toBe(7200);
    await store.close();
  });

  it("uses explicit ttlMs override when provided", async () => {
    const store = new SessionStore(makeConfig() as AppConfig, 1800000);
    const record = {
      sessionKey: "k2", userId: "u2", orgId: "o1", conversationId: "c2",
      clientKind: "test", createdAt: Date.now(), lastActiveAt: Date.now(),
      totalTokensIn: 0, totalTokensOut: 0, totalTokensCached: 0, totalTokensSaved: 0,
      requestCount: 0, escalationCount: 0, consecutiveFailedVerifications: 0,
      metadata: {}, version: 0,
    };
    await store.save(record);
    expect(lastEvalTtl).toBe(1800);
    await store.close();
  });

  it("defaults to config TTL of 14400000ms (4h) = 14400 seconds", async () => {
    const store = new SessionStore(makeConfig() as AppConfig);
    const record = {
      sessionKey: "k3", userId: "u3", orgId: "o1", conversationId: "c3",
      clientKind: "test", createdAt: Date.now(), lastActiveAt: Date.now(),
      totalTokensIn: 0, totalTokensOut: 0, totalTokensCached: 0, totalTokensSaved: 0,
      requestCount: 0, escalationCount: 0, consecutiveFailedVerifications: 0,
      metadata: {}, version: 0,
    };
    await store.save(record);
    expect(lastEvalTtl).toBe(14400);
    await store.close();
  });
});

describe("Conversation Memory — UsageWriter continuity persistence", () => {
  let writer: UsageWriter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (writer) await writer.close();
  });

  it("enqueueContinuityUpsert adds item to the queue", () => {
    writer = new UsageWriter(makeConfig());
    writer.enqueueContinuityUpsert("user1", "org1", "sess1", dummyContinuity());
    const stats = writer.getStats();
    expect(stats.totalEnqueued).toBe(1);
    expect(stats.queueDepth).toBe(1);
  });

  it("flush processes continuity upserts and increments memory stats", async () => {
    writer = new UsageWriter(makeConfig());
    writer.enqueueContinuityUpsert("user1", "org1", "sess1", dummyContinuity());
    await writer.flush();

    const stats = writer.getStats();
    expect(stats.totalFlushed).toBe(1);
    expect(stats.queueDepth).toBe(0);

    const memStats = writer.getConversationMemoryStats();
    expect(memStats.continuityUpserts).toBe(1);
  });

  it("continuity upsert calls pool.query with correct INSERT/ON CONFLICT", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const c = dummyContinuity();
    writer.enqueueContinuityUpsert("user1", "org1", "sess1", c);
    await writer.flush();

    expect(pool.query).toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("yarn_session_continuity")
    )!;
    expect(sql).toContain("INSERT INTO yarn_session_continuity");
    expect(sql).toContain("ON CONFLICT");
    expect(params[0]).toBe("user1");
    expect(params[1]).toBe("org1");
    expect(params[2]).toBe("sess1");
  });

  it("ensureContinuityTable creates the table DDL", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    await writer.ensureContinuityTable();

    const ddlCall = pool.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("CREATE TABLE IF NOT EXISTS yarn_session_continuity")
    );
    expect(ddlCall).toBeTruthy();
    const indexCall = pool.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("idx_continuity_org_user_updated")
    );
    expect(indexCall?.[0]).toContain("(org_id, user_id, updated_at DESC)");
  });

  it("ensureContinuityTable is idempotent", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    await writer.ensureContinuityTable();
    await writer.ensureContinuityTable();

    const ddlCalls = pool.query.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("CREATE TABLE IF NOT EXISTS yarn_session_continuity")
    );
    expect(ddlCalls.length).toBe(1);
  });
});

describe("Conversation Memory — UsageWriter recall loading", () => {
  let writer: UsageWriter;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (writer) await writer.close();
  });

  it("loadLatestContinuity returns null when no rows found", async () => {
    writer = new UsageWriter(makeConfig());
    const result = await writer.loadLatestContinuity("org1", "user1");
    expect(result).toBeNull();

    const memStats = writer.getConversationMemoryStats();
    expect(memStats.recallLoads).toBe(1);
    expect(memStats.recallMisses).toBe(1);
    expect(memStats.recallHits).toBe(0);
  });

  it("loadLatestContinuity returns continuity when row found", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    pool.query.mockResolvedValueOnce({
      rows: [{
        current_task: "Fix auth",
        key_findings: ["found bug"],
        decisions: ["use middleware"],
        recent_files: ["auth.ts"],
        updated_at: new Date().toISOString(),
      }],
    });

    const result = await writer.loadLatestContinuity("org1", "user1");
    expect(result).not.toBeNull();
    expect(result!.currentTask).toBe("Fix auth");
    expect(result!.keyFindings).toEqual(["found bug"]);
    expect(result!.decisions).toEqual(["use middleware"]);
    expect(result!.recentFiles).toEqual(["auth.ts"]);

    const memStats = writer.getConversationMemoryStats();
    expect(memStats.recallHits).toBe(1);
  });

  it("loadLatestContinuity returns null on query error", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const result = await writer.loadLatestContinuity("org1", "user1");
    expect(result).toBeNull();

    const memStats = writer.getConversationMemoryStats();
    expect(memStats.recallMisses).toBe(1);
  });

  it("loadLatestContinuity respects maxAgeMs parameter", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const oneDay = 24 * 60 * 60 * 1000;
    await writer.loadLatestContinuity("org1", "user1", oneDay);

    expect(pool.query).toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("org_id = $1 AND user_id = $2 AND updated_at >= $3");
    expect(params[0]).toBe("org1");
    expect(params[1]).toBe("user1");
    const cutoffDate = new Date(params[2]);
    const expectedCutoff = new Date(Date.now() - oneDay);
    expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(5000);
  });

  it("loadLatestContinuity returns null when pool is null (DB disabled)", async () => {
    writer = new UsageWriter(makeConfig({ SYNESIS_YARN_ADMIN_DB_URL: "" }));
    const result = await writer.loadLatestContinuity("org1", "user1");
    expect(result).toBeNull();
  });
});

describe("Conversation Memory — SessionContinuityService.toRecallBlock", () => {
  it("builds a SESSION_RECALL block from prior session continuity", () => {
    const svc = new SessionContinuityService();
    const block = svc.toRecallBlock(dummyContinuity({ updatedAt: Date.now() - 3 * 60 * 60 * 1000 }));
    expect(block).not.toBeNull();
    expect(block!).toContain("<SESSION_RECALL");
    expect(block!).toContain("prior_session");
    expect(block!).toContain("</SESSION_RECALL>");
    expect(block!).toContain("last_task=Fix auth bug in middleware");
    expect(block!).toContain("prior_findings=");
    expect(block!).toContain("prior_decisions=");
    expect(block!).toContain("prior_files=");
    expect(block!).toContain("age_hours=3");
  });

  it("returns null when continuity is empty", () => {
    const svc = new SessionContinuityService();
    const block = svc.toRecallBlock({
      currentTask: "",
      keyFindings: [],
      decisions: [],
      recentFiles: [],
      updatedAt: Date.now(),
    });
    expect(block).toBeNull();
  });

  it("tracks recallBlocksEmitted in stats", () => {
    const svc = new SessionContinuityService();
    svc.toRecallBlock(dummyContinuity());
    svc.toRecallBlock(dummyContinuity());
    const stats = svc.getStats();
    expect(stats.recallBlocksEmitted).toBe(2);
  });

  it("is distinct from SESSION_CONTINUITY block", () => {
    const svc = new SessionContinuityService();
    const c = dummyContinuity();
    const continuityBlock = svc.toSystemBlock(c);
    const recallBlock = svc.toRecallBlock(c);

    expect(continuityBlock).toContain("<SESSION_CONTINUITY>");
    expect(recallBlock).toContain("<SESSION_RECALL");
    expect(continuityBlock).not.toContain("SESSION_RECALL");
    expect(recallBlock).not.toContain("SESSION_CONTINUITY");
  });
});

describe("Conversation Memory — ConversationMemoryStats", () => {
  let writer: UsageWriter;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (writer) await writer.close();
  });

  it("starts with zero counters", () => {
    writer = new UsageWriter(makeConfig());
    const stats: ConversationMemoryStats = writer.getConversationMemoryStats();
    expect(stats.continuityUpserts).toBe(0);
    expect(stats.recallLoads).toBe(0);
    expect(stats.recallHits).toBe(0);
    expect(stats.recallMisses).toBe(0);
  });

  it("accumulates across multiple operations", async () => {
    writer = new UsageWriter(makeConfig());
    writer.enqueueContinuityUpsert("u1", "o1", "s1", dummyContinuity());
    writer.enqueueContinuityUpsert("u1", "o1", "s2", dummyContinuity());
    await writer.flush();

    await writer.loadLatestContinuity("o1", "u1");
    await writer.loadLatestContinuity("o1", "u2");

    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    pool.query.mockResolvedValueOnce({
      rows: [{ current_task: "x", key_findings: [], decisions: [], recent_files: [], updated_at: new Date().toISOString() }],
    });
    await writer.loadLatestContinuity("o2", "u3");

    const stats = writer.getConversationMemoryStats();
    expect(stats.continuityUpserts).toBe(2);
    expect(stats.recallLoads).toBe(3);
    expect(stats.recallMisses).toBe(2);
    expect(stats.recallHits).toBe(1);
  });
});
