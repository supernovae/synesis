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
});
