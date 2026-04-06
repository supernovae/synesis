import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/state/artifact-store.js";
import { ToolResultReductionService } from "../src/reduction/tool-result-reducer.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(maxRawChars = 100): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "",
    SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
    SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://openrouter.ai/api/v1",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "",
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_YARN_DB_POOL_MAX: 20,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 30000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 3000,
    SYNESIS_YARN_WRITE_QUEUE_MAX: 10000,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 50,
    SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: maxRawChars,
    SYNESIS_YARN_VALIDATION_MAX_FINDINGS: 30,
    SYNESIS_YARN_VALIDATION_INCLUDE_RAW: false,
    SYNESIS_YARN_REDUCERS_ENABLED: true,
    SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: "",
    SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: 0.6,
    SYNESIS_YARN_REDUCER_PROFILE: "balanced",
    SYNESIS_YARN_JSON_COMPACTION_ENABLED: true,
    SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: true,
    SYNESIS_YARN_WORKING_FRAME_ENABLED: true,
    SYNESIS_YARN_PROJECT_MANIFEST_ENABLED: true,
    SYNESIS_YARN_FRAME_MAX_FILES: 12,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true
  } as AppConfig;
}

describe("ToolResultReductionService", () => {
  it("keeps small tool outputs unchanged", () => {
    const svc = new ToolResultReductionService(makeConfig(500), new ArtifactStore());
    const out = svc.reduceMessages([
      { role: "tool", content: "short output", name: "bash" }
    ]);
    expect(out.reducedCount).toBe(0);
    expect(out.messages[0].content).toBe("short output");
  });

  it("reduces oversized tool outputs with artifact handle", () => {
    const store = new ArtifactStore();
    const svc = new ToolResultReductionService(makeConfig(20), store);
    const large = "x".repeat(400);
    const out = svc.reduceMessages([
      { role: "tool", content: large, name: "bash" }
    ]);
    expect(out.reducedCount).toBe(1);
    const reduced = String(out.messages[0].content);
    expect(reduced).toContain("<TOOL_RESULT_SUMMARY");
    expect(reduced).toContain("artifact_handle=");
    const stats = svc.getStats();
    expect(stats.artifactHandleCount).toBe(1);
    expect(stats.tokensSavedEstimateTotal).toBeGreaterThan(0);
  });

  it("can reduce standalone tool result payloads", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult(
      "_____________________ test_add _____________________\nE       assert 1 == 2",
      "pytest"
    );
    expect(out).toContain("<TOOL_REDUCED");
    expect(out).toContain('family="pytest"');
  });

  it("fails safe to artifact summary when no reducer matches and output is oversized", () => {
    const svc = new ToolResultReductionService(makeConfig(20), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult("x".repeat(200), "unknown");
    expect(out).toContain("<TOOL_RESULT_SUMMARY");
    const stats = svc.getStats();
    expect(stats.fallbackToArtifactCount).toBeGreaterThan(0);
  });

  it("tracks enrichedCount and bypassEligibleCount in stats", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    svc.reduceStandaloneToolResult(
      "_____________________ test_add _____________________\nE       assert 1 == 2",
      "pytest"
    );
    const stats = svc.getStats();
    expect(stats.enrichedCount).toBeGreaterThanOrEqual(1);
    expect(typeof stats.bypassEligibleCount).toBe("number");
  });

  it("enrichment stats start at zero", () => {
    const svc = new ToolResultReductionService(makeConfig(500), new ArtifactStore());
    const stats = svc.getStats();
    expect(stats.enrichedCount).toBe(0);
    expect(stats.bypassEligibleCount).toBe(0);
  });

  it("normalizes MCP git_status payloads for git reducer family", () => {
    const svc = new ToolResultReductionService(makeConfig(10), new ArtifactStore());
    const out = svc.reduceStandaloneToolResult(
      {
        exitCode: 0,
        stdout: "## feature/x...origin/feature/x [ahead 1]\n M src/index.ts\n?? notes.md",
        stderr: "",
      },
      "git_status",
    );
    expect(out).toContain("<TOOL_REDUCED");
    expect(out).toContain('family="git"');
  });
});
