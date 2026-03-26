import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTierConfigs } from "../src/providers/admin-tier-registry.js";
import type { AppConfig } from "../src/config.js";

describe("fetchTierConfigs", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("maps coder roles into synesis tiers with provider default endpoint", async () => {
    const payload = {
      roles: [
        {
          role: "coder-core",
          assigned: true,
          provider: "openrouter",
          model: "qwen/qwen3-coder-next:nitro",
          endpoint: "",
          api_key_env: "OPENROUTER_API_KEY"
        }
      ]
    };
    process.env.OPENROUTER_API_KEY = "or-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payload
      })
    );

    const config: AppConfig = {
      PORT: 8000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      SYNESIS_YARN_ADMIN_API_URL: "http://admin",
      SYNESIS_INTERNAL_SERVICE_TOKEN: "",
      SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
      SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
      SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://fallback.example/v1",
      SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "fallback-key",
      SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
      SYNESIS_YARN_ADMIN_DB_URL: "",
      SYNESIS_PAT_PEPPER: "",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true
    };

    const tiers = await fetchTierConfigs(config);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe("synesis-core");
    expect(tiers[0].backendModel).toBe("qwen/qwen3-coder-next:nitro");
    expect(tiers[0].baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(tiers[0].apiKey).toBe("or-test-key");
  });
});
