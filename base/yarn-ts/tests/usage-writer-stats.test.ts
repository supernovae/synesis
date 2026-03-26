import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageWriter, type WriterStats } from "../src/state/usage-writer.js";
import type { AppConfig } from "../src/config.js";

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
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
    SYNESIS_YARN_WRITE_QUEUE_MAX: 3,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
    ...overrides
  };
}

function dummyUsageEvent() {
  return {
    sessionKey: "s1",
    requestId: "r1",
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
}

describe("UsageWriter stats", () => {
  let writer: UsageWriter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (writer) await writer.close();
  });

  it("starts with zero counters", () => {
    writer = new UsageWriter(makeConfig());
    const stats: WriterStats = writer.getStats();
    expect(stats.queueDepth).toBe(0);
    expect(stats.totalEnqueued).toBe(0);
    expect(stats.totalFlushed).toBe(0);
    expect(stats.totalDropped).toBe(0);
    expect(stats.totalFlushErrors).toBe(0);
    expect(stats.lastFlushMs).toBe(0);
  });

  it("increments totalEnqueued and queueDepth on enqueue", () => {
    writer = new UsageWriter(makeConfig());
    writer.enqueueUsageInsert(dummyUsageEvent());
    writer.enqueueUsageInsert(dummyUsageEvent());
    const stats = writer.getStats();
    expect(stats.totalEnqueued).toBe(2);
    expect(stats.queueDepth).toBe(2);
  });

  it("increments totalDropped when queue overflows", () => {
    writer = new UsageWriter(makeConfig({ SYNESIS_YARN_WRITE_QUEUE_MAX: 2 }));
    writer.enqueueUsageInsert(dummyUsageEvent());
    writer.enqueueUsageInsert(dummyUsageEvent());
    writer.enqueueUsageInsert(dummyUsageEvent());
    const stats = writer.getStats();
    expect(stats.totalEnqueued).toBe(3);
    expect(stats.totalDropped).toBe(1);
    expect(stats.queueDepth).toBe(2);
  });

  it("increments totalFlushed and updates lastFlushMs after flush", async () => {
    writer = new UsageWriter(makeConfig());
    writer.enqueueUsageInsert(dummyUsageEvent());
    writer.enqueueUsageInsert(dummyUsageEvent());
    const before = Date.now();
    await writer.flush();
    const stats = writer.getStats();
    expect(stats.totalFlushed).toBe(2);
    expect(stats.queueDepth).toBe(0);
    expect(stats.lastFlushMs).toBeGreaterThanOrEqual(before);
  });

  it("increments totalFlushErrors on DB failure", async () => {
    writer = new UsageWriter(makeConfig());
    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    pool.query.mockRejectedValue(new Error("db down"));

    writer.enqueueUsageInsert(dummyUsageEvent());
    await writer.flush();
    const stats = writer.getStats();
    expect(stats.totalFlushErrors).toBe(1);
    expect(stats.totalFlushed).toBe(0);
    expect(stats.queueDepth).toBe(0);
  });

  it("does not persist when DB is disabled", () => {
    writer = new UsageWriter(makeConfig({ SYNESIS_YARN_ADMIN_DB_URL: "" }));
    writer.enqueueUsageInsert(dummyUsageEvent());
    const stats = writer.getStats();
    expect(stats.totalEnqueued).toBe(0);
    expect(stats.queueDepth).toBe(0);
  });
});
