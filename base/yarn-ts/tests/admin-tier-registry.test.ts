import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTierConfigs, normalizeOpenAICompatTierModelId } from "../src/providers/admin-tier-registry.js";
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
    ...overrides
  };
}

function stubFetch(roles: unknown, costs: unknown) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => roles })
      .mockResolvedValueOnce({ ok: true, json: async () => costs })
  );
}

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
    stubFetch(
      { roles: [{ role: "coder-core", assigned: true, provider: "openrouter", model: "qwen/qwen3-coder-next:nitro", endpoint: "", api_key_env: "OPENROUTER_API_KEY" }] },
      { costs: [{ role: "coder-core", input_per_million: 1.25, output_per_million: 4.5, input_cached_per_million: 0.3 }] }
    );
    process.env.OPENROUTER_API_KEY = "or-test-key";

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe("synesis-core");
    expect(tiers[0].backendModel).toBe("qwen/qwen3-coder-next:nitro");
    expect(tiers[0].baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(tiers[0].apiKey).toBe("or-test-key");
    expect(tiers[0].inputPerM).toBe(1.25);
    expect(tiers[0].outputPerM).toBe(4.5);
    expect(tiers[0].cachedPerM).toBe(0.3);
    expect(tiers[0].pricingSource).toBe("manual");
  });

  it("falls back to SYNESIS_YARN_OPENAI_COMPAT_API_KEY when api_key_env is empty", async () => {
    stubFetch(
      { roles: [{ role: "coder-pulse", assigned: true, provider: "openrouter", model: "qwen/qwen3-coder-flash", endpoint: "", api_key_env: "" }] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig({ SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "global-fallback-key" }));
    expect(tiers).toHaveLength(1);
    expect(tiers[0].apiKey).toBe("global-fallback-key");
    expect(tiers[0].pricingSource).toBe("fallback_base");
    expect(tiers[0].inputPerM).toBe(1.0);
    expect(tiers[0].outputPerM).toBe(5.0);
  });

  it("uses explicit endpoint when provided instead of provider default", async () => {
    stubFetch(
      { roles: [{ role: "coder-horizon", assigned: true, provider: "openrouter", model: "big-model", endpoint: "https://custom.endpoint/v1", api_key_env: "" }] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].baseUrl).toBe("https://custom.endpoint/v1");
  });

  it("falls back to config base URL when provider is unknown and endpoint is empty", async () => {
    stubFetch(
      { roles: [{ role: "coder-core", assigned: true, provider: "some-unknown-provider", model: "model-x", endpoint: "", api_key_env: "" }] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig({ SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://my-fallback/v1" }));
    expect(tiers).toHaveLength(1);
    expect(tiers[0].baseUrl).toBe("https://my-fallback/v1");
  });

  it("skips unrecognized roles without error", async () => {
    stubFetch(
      { roles: [
        { role: "legacy-pulse", assigned: true, provider: "openrouter", model: "some-model", endpoint: "" },
        { role: "coder-core", assigned: true, provider: "openrouter", model: "core-model", endpoint: "" }
      ] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe("synesis-core");
  });

  it("skips unassigned roles", async () => {
    stubFetch(
      { roles: [{ role: "coder-core", assigned: false, provider: "openrouter", model: "model", endpoint: "" }] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(0);
  });

  it("uses route_params.api_base when endpoint is empty", async () => {
    stubFetch(
      { roles: [{ role: "coder-core", assigned: true, provider: "", model: "m", endpoint: "", route_params: { api_base: "https://route-base/v1" } }] },
      { costs: [] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers[0].baseUrl).toBe("https://route-base/v1");
  });

  it("maps coder-compaction role to synesis-compaction tier", async () => {
    stubFetch(
      { roles: [{ role: "coder-compaction", assigned: true, provider: "openrouter", model: "qwen/qwen2.5-coder-7b-instruct", endpoint: "" }] },
      { costs: [{ role: "coder-compaction", input_per_million: 0.15, output_per_million: 0.6, input_cached_per_million: null }] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe("synesis-compaction");
    expect(tiers[0].inputPerM).toBe(0.15);
    expect(tiers[0].cachedPerM).toBeNull();
    expect(tiers[0].pricingSource).toBe("manual");
  });

  it("applies fallback base rates when admin returns zero pricing for a role", async () => {
    stubFetch(
      { roles: [{ role: "coder-core", assigned: true, provider: "vllm", model: "local-model", endpoint: "http://local:8000/v1" }] },
      { costs: [{ role: "coder-core", input_per_million: 0, output_per_million: 0 }] }
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].pricingSource).toBe("fallback_base");
    expect(tiers[0].inputPerM).toBe(1.0);
    expect(tiers[0].outputPerM).toBe(5.0);
    expect(tiers[0].cachedPerM).toBe(0.1);
  });

  it("exposes registry sampling defaults for tier fallback behavior", async () => {
    stubFetch(
      {
        roles: [
          {
            role: "coder-core",
            assigned: true,
            provider: "openrouter",
            model: "qwen/qwen3.6-35b-a3b",
            endpoint: "",
            route_params: {
              temperature: 0.6,
              top_p: 0.95,
              top_k: 20,
              min_p: 0.0,
              presence_penalty: 0.0,
              repetition_penalty: 1.0,
              enable_thinking: true,
            },
          },
        ],
      },
      { costs: [] },
    );

    const tiers = await fetchTierConfigs(makeConfig());
    expect(tiers).toHaveLength(1);
    expect(tiers[0].samplingDefaults).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
      enable_thinking: true,
    });
  });

  it("parses architecture profile overrides from route params", async () => {
    stubFetch(
      {
        roles: [
          {
            role: "coder-core",
            assigned: true,
            provider: "openrouter",
            model: "deepseek/deepseek-r1",
            endpoint: "",
            route_params: {
              architecture_attention: "full_attention",
              effective_working_context_tokens: 120000,
              architecture_compaction_sensitivity: "low",
              architecture_profile: {
                recommendations: { preferShorterTurns: false },
              },
            },
          },
        ],
      },
      { costs: [] },
    );

    const tiers = await fetchTierConfigs(makeConfig());

    expect(tiers[0].architectureProfile).toMatchObject({
      attention: "full_attention",
      effectiveWorkingContextTokens: 120000,
      traits: { compactionSensitivity: "low" },
      recommendations: { preferShorterTurns: false },
    });
  });
});

describe("normalizeOpenAICompatTierModelId", () => {
  it("maps short and canonical synesis tier names", () => {
    expect(normalizeOpenAICompatTierModelId("core")).toBe("synesis-core");
    expect(normalizeOpenAICompatTierModelId("pulse")).toBe("synesis-pulse");
    expect(normalizeOpenAICompatTierModelId("horizon")).toBe("synesis-horizon");
    expect(normalizeOpenAICompatTierModelId("synesis-core")).toBe("synesis-core");
    expect(normalizeOpenAICompatTierModelId("Coder-Core")).toBe("synesis-core");
  });

  it("maps the last slash segment", () => {
    expect(normalizeOpenAICompatTierModelId("openai/core")).toBe("synesis-core");
    expect(normalizeOpenAICompatTierModelId("x/y/synesis-pulse")).toBe("synesis-pulse");
  });

  it("passes through unknown vendor ids", () => {
    expect(normalizeOpenAICompatTierModelId("gpt-4.1")).toBe("gpt-4.1");
  });
});
