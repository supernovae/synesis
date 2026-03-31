import { afterEach, describe, expect, it, vi } from "vitest";
import { EnrichmentPool, type EnrichmentPoolStats } from "../src/workers/pool.js";
import { compactJsonArray } from "../src/reduction/json-compactor.js";
import {
  detectContentType,
  compressLogStream,
  summarizeJsonObject,
} from "../src/reduction/content-dispatch.js";
import { ToolResultReductionService } from "../src/reduction/tool-result-reducer.js";
import { ArtifactStore } from "../src/state/artifact-store.js";
import type { AppConfig } from "../src/config.js";

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
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: 12000,
    SYNESIS_YARN_VALIDATION_MAX_FINDINGS: 30,
    SYNESIS_YARN_VALIDATION_INCLUDE_RAW: false,
    SYNESIS_YARN_REDUCERS_ENABLED: true,
    SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: "",
    SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: 0.6,
    SYNESIS_YARN_REDUCER_PROFILE: "balanced",
    SYNESIS_YARN_JSON_COMPACTION_ENABLED: true,
    SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: true,
    SYNESIS_YARN_RECALL_BYPASS_ENABLED: false,
    SYNESIS_YARN_RECALL_BYPASS_CONFIDENCE_THRESHOLD: 0.8,
    SYNESIS_YARN_RECALL_ENRICH_THRESHOLD: 0.4,
    SYNESIS_YARN_WORKER_POOL_ENABLED: false,
    SYNESIS_YARN_WORKER_POOL_SIZE: 2,
    SYNESIS_YARN_WORKER_TASK_TIMEOUT_MS: 5000,
    ...overrides,
  } as AppConfig;
}

function makeHomogeneousArray(n: number): string {
  const items = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `item-${i + 1}`,
    status: i === 7 ? "error" : "ok",
    score: Math.round(Math.random() * 100),
  }));
  return JSON.stringify(items);
}

function makeLogStream(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) =>
      `2025-01-15T10:${String(i % 60).padStart(2, "0")}:00Z INFO  Processing request ${i}`,
  ).join("\n");
}

function makeLargeJsonObject(): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) {
    obj[`key_${i}`] = "x".repeat(100);
  }
  return JSON.stringify(obj);
}

describe("EnrichmentPool — disabled (sync fallback)", () => {
  it("reports not available when disabled", () => {
    const pool = new EnrichmentPool(makeConfig({ SYNESIS_YARN_WORKER_POOL_ENABLED: false }));
    expect(pool.isAvailable()).toBe(false);
  });

  it("compactJsonAsync falls back to sync when pool disabled", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeHomogeneousArray(50);
    const asyncResult = await pool.compactJsonAsync(raw);
    const syncResult = compactJsonArray(raw);
    expect(asyncResult?.originalItems).toBe(syncResult?.originalItems);
    expect(asyncResult?.keptItems).toBe(syncResult?.keptItems);
    await pool.close();
  });

  it("dispatchContentAsync falls back to sync for log-stream", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeLogStream(100);
    const result = await pool.dispatchContentAsync(raw);
    expect(result.contentType).toBe("log-stream");
    expect(result.transformed).not.toBeNull();
    expect(result.transformed).toContain("LOG_STREAM");
    await pool.close();
  });

  it("dispatchContentAsync falls back to sync for json-object", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeLargeJsonObject();
    const result = await pool.dispatchContentAsync(raw);
    expect(result.contentType).toBe("json-object");
    expect(result.transformed).toContain("JSON_SUMMARY");
    await pool.close();
  });

  it("dispatchContentAsync returns text type for plain text", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const result = await pool.dispatchContentAsync("Just some plain text output");
    expect(result.contentType).toBe("text");
    expect(result.transformed).toBeNull();
    await pool.close();
  });

  it("tracks syncFallbacks in stats", async () => {
    const pool = new EnrichmentPool(makeConfig());
    await pool.compactJsonAsync(makeHomogeneousArray(50));
    await pool.dispatchContentAsync("hello");
    const stats = pool.getStats();
    expect(stats.enabled).toBe(false);
    expect(stats.syncFallbacks).toBe(0);
    await pool.close();
  });

  it("getStats returns zero counters when disabled", () => {
    const pool = new EnrichmentPool(makeConfig());
    const stats: EnrichmentPoolStats = pool.getStats();
    expect(stats.enabled).toBe(false);
    expect(stats.completedTasks).toBe(0);
    expect(stats.failedTasks).toBe(0);
    expect(stats.syncFallbacks).toBe(0);
  });
});

describe("EnrichmentPool — task correctness (sync path)", () => {
  it("compactJsonArray produces identical output via pool sync fallback", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeHomogeneousArray(100);
    const poolResult = await pool.compactJsonAsync(raw);
    const directResult = compactJsonArray(raw);
    expect(poolResult?.compacted).toBe(directResult?.compacted);
    expect(poolResult?.originalItems).toBe(directResult?.originalItems);
    expect(poolResult?.keptItems).toBe(directResult?.keptItems);
    await pool.close();
  });

  it("detectContentType via pool matches direct call for json-array", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeHomogeneousArray(10);
    const poolResult = await pool.dispatchContentAsync(raw);
    expect(poolResult.contentType).toBe(detectContentType(raw));
    await pool.close();
  });

  it("compressLogStream via pool matches direct call", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeLogStream(200);
    const poolResult = await pool.dispatchContentAsync(raw);
    const directResult = compressLogStream(raw);
    expect(poolResult.transformed).toBe(directResult);
    await pool.close();
  });

  it("summarizeJsonObject via pool matches direct call for large objects", async () => {
    const pool = new EnrichmentPool(makeConfig());
    const raw = makeLargeJsonObject();
    const poolResult = await pool.dispatchContentAsync(raw);
    const directResult = summarizeJsonObject(raw);
    expect(poolResult.transformed).toBe(directResult);
    await pool.close();
  });
});

describe("ToolResultReductionService.reduceMessagesAsync — parity", () => {
  it("produces same output as sync reduceMessages for tool messages", async () => {
    const config = makeConfig();
    const artifactStore = new ArtifactStore({
      maxCount: 500,
      ttlMs: 3600000,
      maxPayloadBytes: 1048576,
    });
    const svc = new ToolResultReductionService(config, artifactStore);
    const pool = new EnrichmentPool(config);

    const messages = [
      { role: "user", content: "Run the tests" },
      { role: "assistant", content: "Running tests now." },
      {
        role: "tool",
        name: "run_command",
        content: makeLogStream(80),
      },
      { role: "tool", name: "read_file", content: "short content" },
    ];

    const syncResult = svc.reduceMessages(messages as never);
    const svc2 = new ToolResultReductionService(config, artifactStore);
    const asyncResult = await svc2.reduceMessagesAsync(messages as never, pool);

    expect(asyncResult.reducedCount).toBe(syncResult.reducedCount);
    expect(asyncResult.messages.length).toBe(syncResult.messages.length);

    for (let i = 0; i < syncResult.messages.length; i++) {
      expect(asyncResult.messages[i].role).toBe(syncResult.messages[i].role);
    }

    artifactStore.close();
    await pool.close();
  });

  it("falls back to sync when pool is unavailable", async () => {
    const config = makeConfig();
    const artifactStore = new ArtifactStore({
      maxCount: 500,
      ttlMs: 3600000,
      maxPayloadBytes: 1048576,
    });
    const svc = new ToolResultReductionService(config, artifactStore);
    const pool = new EnrichmentPool(config);

    const messages = [
      { role: "user", content: "hello" },
      { role: "tool", name: "test", content: "short" },
    ];

    const result = await svc.reduceMessagesAsync(messages as never, pool);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].role).toBe("user");

    artifactStore.close();
    await pool.close();
  });

  it("handles empty messages array", async () => {
    const config = makeConfig();
    const artifactStore = new ArtifactStore({
      maxCount: 500,
      ttlMs: 3600000,
      maxPayloadBytes: 1048576,
    });
    const svc = new ToolResultReductionService(config, artifactStore);
    const pool = new EnrichmentPool(config);

    const result = await svc.reduceMessagesAsync([], pool);
    expect(result.messages).toEqual([]);
    expect(result.reducedCount).toBe(0);

    artifactStore.close();
    await pool.close();
  });

  it("handles messages with no tool results", async () => {
    const config = makeConfig();
    const artifactStore = new ArtifactStore({
      maxCount: 500,
      ttlMs: 3600000,
      maxPayloadBytes: 1048576,
    });
    const svc = new ToolResultReductionService(config, artifactStore);
    const pool = new EnrichmentPool(config);

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await svc.reduceMessagesAsync(messages as never, pool);
    expect(result.messages.length).toBe(2);
    expect(result.reducedCount).toBe(0);

    artifactStore.close();
    await pool.close();
  });
});

describe("EnrichmentPool — close and lifecycle", () => {
  it("close is safe to call multiple times", async () => {
    const pool = new EnrichmentPool(makeConfig());
    await pool.close();
    await pool.close();
    expect(pool.isAvailable()).toBe(false);
  });

  it("isAvailable returns false after close", async () => {
    const pool = new EnrichmentPool(makeConfig());
    expect(pool.isAvailable()).toBe(false);
    await pool.close();
    expect(pool.isAvailable()).toBe(false);
  });
});
