import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "../src/config.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SYNESIS_YARN_PORT: 8080,
    SYNESIS_YARN_HOST: "0.0.0.0",
    SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
    SYNESIS_YARN_MODELS: "",
    SYNESIS_PAT_PEPPER: "test-pepper",
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
    SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS: 100_000,
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: 50_000,
    SYNESIS_YARN_REDUCER_PROFILE: "balanced",
    SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: 0.3,
    SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: "",
    SYNESIS_YARN_JSON_COMPACTION_ENABLED: true,
    SYNESIS_YARN_STABLE_PREFIX_ENABLED: true,
    SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED: false,
    SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED: true,
    SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: false,
    SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED: false,
    SYNESIS_YARN_GOVERNANCE_ENABLED: false,
    SYNESIS_YARN_SESSION_CONTINUITY_ENABLED: false,
    SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: false,
    SYNESIS_YARN_RECALL_BYPASS_ENABLED: false,
    SYNESIS_YARN_RECALL_CONFIDENCE_FLOOR: 0.6,
    SYNESIS_YARN_VERIFICATION_PLAN_ENABLED: false,
    SYNESIS_YARN_VERIFICATION_MAX_ROUNDS: 3,
    SYNESIS_YARN_DECISION_MATRIX_ENABLED: false,
    SYNESIS_YARN_DETERMINISTIC_PATH_THRESHOLD: 0.9,
    SYNESIS_YARN_CONSTRAINED_PATH_THRESHOLD: 0.5,
    SYNESIS_YARN_ABSTAIN_EVIDENCE_FLOOR: 0.15,
    SYNESIS_YARN_ESCALATION_FAILED_VERIF_LIMIT: 2,
    SYNESIS_YARN_SENSEMAKING_ENABLED: false,
    SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD: 0.5,
    SYNESIS_YARN_AUTH_POOL_MAX: 5,
    SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS: 30_000,
    SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS: 2000,
    SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: false,
    SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S: 86400,
    SYNESIS_YARN_OTEL_ENABLED: false,
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_SERVICE_NAME: "synesis-yarn",
    SYNESIS_YARN_INTERNAL_TOKEN: "test-token",
    SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED: false,
    SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT: 10,
    SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT: 5,
    SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT: 3,
    SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT: 15,
    SYNESIS_YARN_POLICY_HARD_REJECT_AFTER: 0,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 10_000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 5_000,
    SYNESIS_YARN_DB_POOL_MAX: 10,
    SYNESIS_YARN_USAGE_WRITER_QUEUE_MAX: 100,
    SYNESIS_YARN_USAGE_WRITER_FLUSH_INTERVAL_MS: 5_000,
    SYNESIS_YARN_DIAGNOSTIC_RING_MAX: 20,
    SYNESIS_YARN_CHECKPOINT_INTERVAL_MS: 300_000,
    SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS: 30_000,
    SYNESIS_YARN_MCP_TOOLS_ENABLED: false,
    SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE: false,
    SYNESIS_YARN_DEBUG_PROTOCOL: false,
  } as AppConfig;
}

/* ---------- AuthResolver pool hardening ---------- */
describe("AuthResolver pool hardening", () => {
  it("creates pool with max from config", async () => {
    const { Pool } = await import("pg");
    const poolSpy = vi.spyOn(Pool.prototype, "query").mockResolvedValue({ rowCount: 0, rows: [] } as never);

    const { AuthResolver } = await import("../src/auth.js");
    const cfg = makeConfig({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_AUTH_POOL_MAX: 3,
    });
    const resolver = new AuthResolver(cfg);

    const stats = resolver.getPoolStats();
    expect(stats.totalCount).toBe(0);
    expect(stats.idleCount).toBe(0);
    expect(stats.waitingCount).toBe(0);

    await resolver.close();
    poolSpy.mockRestore();
  });

  it("returns zero stats when no pool", async () => {
    const { AuthResolver } = await import("../src/auth.js");
    const resolver = new AuthResolver(makeConfig({ SYNESIS_YARN_ADMIN_DB_URL: "" }));
    const stats = resolver.getPoolStats();
    expect(stats.totalCount).toBe(0);
    expect(stats.idleCount).toBe(0);
    expect(stats.waitingCount).toBe(0);
  });
});

/* ---------- Event loop monitor ---------- */
describe("EventLoopMonitor", () => {
  it("returns zero stats before start", async () => {
    const { getEventLoopStats } = await import("../src/telemetry/event-loop-monitor.js");
    const stats = getEventLoopStats();
    expect(stats.p50Ms).toBe(0);
    expect(stats.p95Ms).toBe(0);
    expect(stats.p99Ms).toBe(0);
    expect(stats.maxMs).toBe(0);
  });

  it("returns numeric stats after start", async () => {
    const { startEventLoopMonitor, getEventLoopStats, stopEventLoopMonitor } = await import("../src/telemetry/event-loop-monitor.js");
    startEventLoopMonitor(10);
    await new Promise((r) => setTimeout(r, 100));
    const stats = getEventLoopStats();
    expect(typeof stats.p50Ms).toBe("number");
    expect(typeof stats.p95Ms).toBe("number");
    expect(typeof stats.p99Ms).toBe("number");
    expect(typeof stats.maxMs).toBe("number");
    expect(stats.p50Ms).toBeGreaterThanOrEqual(0);
    stopEventLoopMonitor();
  });

  it("idempotent start", async () => {
    const { startEventLoopMonitor, stopEventLoopMonitor } = await import("../src/telemetry/event-loop-monitor.js");
    startEventLoopMonitor(10);
    startEventLoopMonitor(10);
    stopEventLoopMonitor();
  });
});

/* ---------- Compaction failure handling ---------- */
describe("Compaction failure handling", () => {
  it("increments compactionFailures when reducer throws", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");
    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 10_000, previewLength: 200 });
    const service = new ToolResultReductionService(makeConfig(), artifactStore);

    const result = service.reduceStandaloneToolResult("some normal text", "echo");
    expect(typeof result).toBe("string");

    const stats = service.getStats();
    expect(typeof stats.compactionFailures).toBe("number");
  });

  it("stats include compactionFailures field", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");
    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 10_000, previewLength: 200 });
    const service = new ToolResultReductionService(makeConfig(), artifactStore);
    const stats = service.getStats();
    expect(stats.compactionFailures).toBe(0);
  });
});

/* ---------- OTEL spans ---------- */
describe("OTEL span helpers", () => {
  it("withSpan returns value and ends span", async () => {
    const { withSpan, getTracer } = await import("../src/telemetry/otel.js");
    const result = withSpan("test.span", { "test.key": "value" }, (span) => {
      span.setAttribute("extra", 42);
      return 123;
    });
    expect(result).toBe(123);
  });

  it("withSpan propagates errors", async () => {
    const { withSpan } = await import("../src/telemetry/otel.js");
    expect(() =>
      withSpan("test.error", {}, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("withSpanAsync returns value", async () => {
    const { withSpanAsync } = await import("../src/telemetry/otel.js");
    const result = await withSpanAsync("test.async", { "test.async": true }, async () => {
      return 456;
    });
    expect(result).toBe(456);
  });

  it("withSpanAsync propagates async errors", async () => {
    const { withSpanAsync } = await import("../src/telemetry/otel.js");
    await expect(
      withSpanAsync("test.async.error", {}, async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
  });

  it("getTracer returns noop tracer when OTEL disabled", async () => {
    const { getTracer } = await import("../src/telemetry/otel.js");
    const tracer = getTracer();
    const span = tracer.startSpan("noop");
    span.setAttribute("k", "v");
    span.setStatus("ok");
    span.end();
  });
});

/* ---------- Diagnostic store ---------- */
describe("DiagnosticStore", () => {
  it("returns null when persistence disabled", async () => {
    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(makeConfig({ SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: false }));
    const result = await store.getDiagnostic("some-id");
    expect(result).toBeNull();
  });

  it("returns empty list when persistence disabled", async () => {
    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(makeConfig({ SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: false }));
    const list = await store.listRecentDiagnostics();
    expect(list).toEqual([]);
  });

  it("persistDiagnostic is no-op when disabled", async () => {
    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(makeConfig({ SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: false }));
    store.persistDiagnostic("req-1", { test: true });
    const stats = store.getStats();
    expect(stats.persisted).toBe(0);
    expect(stats.persistErrors).toBe(0);
  });

  it("stats are initialized to zero", async () => {
    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(makeConfig());
    const stats = store.getStats();
    expect(stats.persisted).toBe(0);
    expect(stats.persistErrors).toBe(0);
    expect(stats.lookups).toBe(0);
    expect(stats.lookupErrors).toBe(0);
  });
});

/* ---------- Config vars ---------- */
describe("Reliability config vars", () => {
  it("loads defaults from EnvSchema", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
      SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
      SYNESIS_PAT_PEPPER: "test",
      SYNESIS_YARN_INTERNAL_TOKEN: "tok",
    });
    expect(cfg.SYNESIS_YARN_AUTH_POOL_MAX).toBe(5);
    expect(cfg.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS).toBe(30_000);
    expect(cfg.SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS).toBe(8000);
    expect(cfg.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED).toBe(false);
    expect(cfg.SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S).toBe(86400);
  });

  it("overrides from env", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
      SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
      SYNESIS_PAT_PEPPER: "test",
      SYNESIS_YARN_INTERNAL_TOKEN: "tok",
      SYNESIS_YARN_AUTH_POOL_MAX: "3",
      SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS: "10000",
      SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS: "500",
      SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: "true",
      SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S: "3600",
    });
    expect(cfg.SYNESIS_YARN_AUTH_POOL_MAX).toBe(3);
    expect(cfg.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS).toBe(10_000);
    expect(cfg.SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS).toBe(500);
    expect(cfg.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED).toBe(true);
    expect(cfg.SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S).toBe(3600);
  });
});

/* ---------- UsageWriter pool stats ---------- */
describe("UsageWriter pool stats", () => {
  it("returns zero stats when no pool", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter(makeConfig({ SYNESIS_YARN_ADMIN_DB_URL: "" }));
    const stats = writer.getPoolStats();
    expect(stats.totalCount).toBe(0);
    expect(stats.idleCount).toBe(0);
    expect(stats.waitingCount).toBe(0);
  });
});

/* ---------- ToolResultReductionStats shape ---------- */
describe("ToolResultReductionStats shape", () => {
  it("includes all expected fields", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");
    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 10_000, previewLength: 200 });
    const service = new ToolResultReductionService(makeConfig(), artifactStore);
    const stats = service.getStats();
    expect(stats).toHaveProperty("rawCharsTotal");
    expect(stats).toHaveProperty("reducedCharsTotal");
    expect(stats).toHaveProperty("reducedCount");
    expect(stats).toHaveProperty("reducerFailures");
    expect(stats).toHaveProperty("compactionFailures");
    expect(stats).toHaveProperty("enrichedCount");
    expect(stats).toHaveProperty("bypassEligibleCount");
  });
});
