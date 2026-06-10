import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns all defaults with empty env", () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(8000);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.SYNESIS_YARN_DEFAULT_TIER).toBe("synesis-core");
    expect(config.SYNESIS_YARN_TIER_POLL_INTERVAL).toBe(60);
    expect(config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS).toBe(12);
    expect(config.SYNESIS_YARN_DB_POOL_MAX).toBe(20);
    expect(config.SYNESIS_YARN_DB_POOL_IDLE_MS).toBe(30000);
    expect(config.SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS).toBe(3000);
    expect(config.SYNESIS_YARN_WRITE_QUEUE_MAX).toBe(10000);
    expect(config.SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS).toBe(50);
    expect(config.SYNESIS_YARN_REDUCERS_ENABLED).toBe(true);
    expect(config.SYNESIS_YARN_REDUCER_PROFILE).toBe("balanced");
    expect(config.SYNESIS_YARN_COMPLETION_GATE_ENABLED).toBe(false);
    expect(config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL).toBe(false);
    expect(config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION).toBe(true);
    expect(config.SYNESIS_YARN_PLANNING_USE_HORIZON).toBe(true);
    expect(config.SYNESIS_YARN_RESPONSE_STYLE_MODE).toBe("guidance");
    expect(config.SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID).toBe(true);
    expect(config.SYNESIS_YARN_CLAUDE_TIER_MAP).toEqual({});
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE).toBe("off");
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT).toBe(10);
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS).toBe(3);
    expect(config.SYNESIS_REQUIRE_PAT_PEPPER).toBe(false);
    expect(config.SYNESIS_YARN_ALLOW_OPAQUE_BEARER).toBe(false);
    expect(config.SYNESIS_YARN_DEBUG_PROTOCOL).toBe(false);
  });

  it("parses DashScope explicit cache controls", () => {
    const config = loadConfig({
      SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE: "canary",
      SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT: "25",
      SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS: "2",
    } as never);
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE).toBe("canary");
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT).toBe(25);
    expect(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS).toBe(2);
  });

  it("parses SYNESIS_YARN_CLAUDE_TIER_MAP JSON", () => {
    const config = loadConfig({
      SYNESIS_YARN_CLAUDE_TIER_MAP: '{"opus":"synesis-core","bad":"unknown-tier"}',
    } as never);
    expect(config.SYNESIS_YARN_CLAUDE_TIER_MAP).toEqual({ opus: "synesis-core" });
  });

  it("defaults SYNESIS_YARN_SESSION_TTL_MS to 14400000 (4 hours)", () => {
    const config = loadConfig({});
    expect(config.SYNESIS_YARN_SESSION_TTL_MS).toBe(14_400_000);
  });

  it("overrides SESSION_TTL_MS from env", () => {
    const config = loadConfig({ SYNESIS_YARN_SESSION_TTL_MS: "60000" } as never);
    expect(config.SYNESIS_YARN_SESSION_TTL_MS).toBe(60000);
  });

  it("transforms PERSIST_USAGE_TO_DB 'false' to boolean false", () => {
    const config = loadConfig({ SYNESIS_YARN_PERSIST_USAGE_TO_DB: "false" } as never);
    expect(config.SYNESIS_YARN_PERSIST_USAGE_TO_DB).toBe(false);
  });

  it("transforms PERSIST_USAGE_TO_DB 'true' to boolean true", () => {
    const config = loadConfig({ SYNESIS_YARN_PERSIST_USAGE_TO_DB: "true" } as never);
    expect(config.SYNESIS_YARN_PERSIST_USAGE_TO_DB).toBe(true);
  });

  it("defaults PERSIST_USAGE_TO_DB to true when not set", () => {
    const config = loadConfig({});
    expect(config.SYNESIS_YARN_PERSIST_USAGE_TO_DB).toBe(true);
  });

  it("coerces PORT from string to number", () => {
    const config = loadConfig({ PORT: "9000" } as never);
    expect(config.PORT).toBe(9000);
  });

  it("requires PAT pepper when requested with DB PAT validation", () => {
    expect(() =>
      loadConfig({
        SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
        SYNESIS_REQUIRE_PAT_PEPPER: "true",
        SYNESIS_PAT_PEPPER: "",
      } as never),
    ).toThrow(/SYNESIS_PAT_PEPPER/);
  });
});
