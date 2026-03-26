import { describe, expect, it, vi, afterEach } from "vitest";
import crypto from "node:crypto";

describe("Idempotent request IDs", () => {
  it("crypto.randomUUID produces valid UUID v4 format", () => {
    const id = crypto.randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates unique IDs across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(crypto.randomUUID());
    }
    expect(ids.size).toBe(1000);
  });

  it("chatcmpl and msg prefixed IDs are distinct", () => {
    const chatId = `chatcmpl-${crypto.randomUUID()}`;
    const msgId = `msg-${crypto.randomUUID()}`;
    expect(chatId).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
    expect(msgId).toMatch(/^msg-[0-9a-f-]{36}$/);
    expect(chatId).not.toBe(msgId);
  });
});

vi.mock("ioredis", () => {
  class MockRedis {
    get = vi.fn();
    eval = vi.fn();
    quit = vi.fn().mockResolvedValue(undefined);
  }
  return { Redis: MockRedis };
});

describe("SessionStore CAS versioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save succeeds when version matches (CAS returns 1)", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3"
    } as never);

    const redis = (store as unknown as { redis: typeof mockRedis }).redis;
    redis.eval = vi.fn().mockResolvedValue(1);

    const record = {
      sessionKey: "s1",
      userId: "u1",
      orgId: "",
      conversationId: "",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 100,
      totalTokensOut: 50,
      totalTokensCached: 0,
      requestCount: 5,
      escalationCount: 0,
      metadata: {},
      version: 3
    };

    const ok = await store.save(record);
    expect(ok).toBe(true);
    expect(record.version).toBe(4);
    expect(redis.eval).toHaveBeenCalledOnce();
    const evalArgs = redis.eval.mock.calls[0];
    expect(evalArgs[2]).toBe("yarn-ts:session:s1");
    expect(evalArgs[3]).toBe("3");
    const serialized = JSON.parse(evalArgs[4] as string);
    expect(serialized.version).toBe(4);

    await store.close();
  });

  it("save fails when version is stale (CAS returns 0)", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3"
    } as never);

    const redis = (store as unknown as { redis: typeof mockRedis }).redis;
    redis.eval = vi.fn().mockResolvedValue(0);

    const record = {
      sessionKey: "s1",
      userId: "u1",
      orgId: "",
      conversationId: "",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 100,
      totalTokensOut: 50,
      totalTokensCached: 0,
      requestCount: 5,
      escalationCount: 0,
      metadata: {},
      version: 2
    };

    const ok = await store.save(record);
    expect(ok).toBe(false);
    expect(record.version).toBe(2);

    await store.close();
  });

  it("load returns version 0 for records missing version field", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3"
    } as never);

    const redis = (store as unknown as { redis: typeof mockRedis }).redis;
    redis.get = vi.fn().mockResolvedValue(JSON.stringify({
      sessionKey: "s1",
      userId: "u1",
      totalTokensIn: 10
    }));

    const record = await store.load("s1");
    expect(record).not.toBeNull();
    expect(record!.version).toBe(0);

    await store.close();
  });
});

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

describe("Idempotent usage writes", () => {

  it("insertUsage query includes ON CONFLICT DO NOTHING", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
      SYNESIS_YARN_DB_POOL_MAX: 5,
      SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
      SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
      SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
      SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999
    } as never);

    writer.enqueueUsageInsert({
      sessionKey: "s1",
      requestId: `chatcmpl-${crypto.randomUUID()}`,
      userId: "u1",
      orgId: "o1",
      provider: "p",
      model: "m",
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 0,
      latencyMs: 50,
      costUsd: 0.001,
      escalated: false,
      toolCallsCount: 1,
      finishReason: "stop"
    });

    await writer.flush();

    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const sql = pool.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("ON CONFLICT (request_id) DO NOTHING");

    await writer.close();
  });

  it("duplicate request_id does not throw", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
      SYNESIS_YARN_DB_POOL_MAX: 5,
      SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
      SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
      SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
      SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999
    } as never);

    const event = {
      sessionKey: "s1",
      requestId: `chatcmpl-${crypto.randomUUID()}`,
      userId: "u1",
      orgId: "o1",
      provider: "p",
      model: "m",
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 0,
      latencyMs: 50,
      costUsd: 0.001,
      escalated: false,
      toolCallsCount: 1,
      finishReason: "stop"
    };

    writer.enqueueUsageInsert(event);
    writer.enqueueUsageInsert(event);
    await expect(writer.flush()).resolves.not.toThrow();

    const stats = writer.getStats();
    expect(stats.totalFlushed).toBe(2);

    await writer.close();
  });
});
