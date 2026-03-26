import { describe, expect, it } from "vitest";
import { ValidationNormalizationService } from "../src/validation/service.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(): AppConfig {
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
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: 1000,
    SYNESIS_YARN_VALIDATION_MAX_FINDINGS: 20,
    SYNESIS_YARN_VALIDATION_INCLUDE_RAW: false,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true
  };
}

describe("ValidationNormalizationService", () => {
  it("normalizes validator-like tool outputs and tracks savings", () => {
    const svc = new ValidationNormalizationService(makeConfig());
    const raw = [
      "src/foo.ts(10,1): error TS2304: Cannot find name 'x'.",
      "src/bar.ts(11,2): error TS2322: Type 'string' is not assignable to type 'number'."
    ].join("\n");
    const out = svc.normalizeMessages([
      { role: "tool", name: "tsc", content: raw },
      { role: "user", content: "continue" }
    ]);

    expect(out.normalizedCount).toBe(1);
    expect(String(out.messages[0].content)).toContain("<VALIDATION_SUMMARY");
    const stats = svc.getStats();
    expect(stats.rawCharsTotal).toBe(raw.length);
    expect(stats.findingsTotal).toBeGreaterThan(0);
    expect(stats.tokensSavedEstimateTotal).toBeGreaterThanOrEqual(0);
  });
});
