import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicOfferingsForYarn,
  mergeYarnPublicOfferingsIntoTiers,
  type TierConfig,
} from "../src/providers/admin-tier-registry.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "internal-token",
    SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
    SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://fallback.example/v1",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "fallback-key",
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_YARN_DB_POOL_MAX: 20,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 30000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 3000,
    SYNESIS_YARN_WRITE_QUEUE_MAX: 10000,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 50,
    SYNESIS_YARN_SESSION_TTL_MS: 14400000,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
    ...overrides,
  };
}

describe("mergeYarnPublicOfferingsIntoTiers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base: TierConfig[] = [
    {
      id: "synesis-core",
      backendModel: "m-core",
      baseUrl: "http://x",
      apiKey: "k",
      inputPerM: 1,
      outputPerM: 2,
      cachedPerM: null,
      cacheWritePerM: null,
      pricingSource: "manual",
    },
  ];

  it("clones coder-core tier under client id with backend override", () => {
    const merged = mergeYarnPublicOfferingsIntoTiers(base, [
      { client_model_id: "exp-test", effort_tier: "core", backend_model_override: "override-model" },
    ]);
    const custom = merged.find((t) => t.id === "exp-test");
    expect(custom?.backendModel).toBe("override-model");
    expect(custom?.baseUrl).toBe("http://x");
    expect(merged.find((t) => t.id === "synesis-core")).toBeDefined();
  });

  it("inherits backend model when override empty", () => {
    const merged = mergeYarnPublicOfferingsIntoTiers(base, [
      { client_model_id: "exp-2", effort_tier: "core", backend_model_override: null },
    ]);
    expect(merged.find((t) => t.id === "exp-2")?.backendModel).toBe("m-core");
  });

  it("supports standalone offering endpoint/api key for yarn", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "standalone-k";
    try {
      const merged = mergeYarnPublicOfferingsIntoTiers(base, [
        {
          client_model_id: "xiaomi-2.5",
          effort_tier: "core",
          connection_mode: "standalone",
          standalone_provider: "openrouter",
          standalone_endpoint: "https://openrouter.ai/api/v1",
          standalone_api_key_env: "OPENROUTER_API_KEY",
          backend_model_override: null,
          generation_params: { model_capability_preset: "xiaomi_mimo_2_5" },
        },
      ]);
      const standalone = merged.find((t) => t.id === "xiaomi-2.5");
      expect(standalone?.backendModel).toBe("xiaomi-2.5");
      expect(standalone?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(standalone?.apiKey).toBe("standalone-k");
      expect(standalone?.modelCapabilityPreset).toBe("xiaomi_mimo_2_5");
      expect(standalone?.providerTelemetryTag).toBeNull();
    } finally {
      process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("drops public offerings when generation_params contain unknown keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          offerings: [
            {
              client_model_id: "unsafe-public-model",
              effort_tier: "core",
              generation_params: {
                model_capability_preset: "xiaomi_mimo_2_5",
                invented_provider_flag: "unsafe",
              },
            },
          ],
        }),
      }),
    );

    await expect(fetchPublicOfferingsForYarn(makeConfig())).resolves.toEqual([]);
  });
});
