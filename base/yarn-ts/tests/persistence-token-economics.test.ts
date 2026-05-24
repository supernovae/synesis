import { describe, expect, it, vi } from "vitest";
import type { TierConfig } from "../src/providers/admin-tier-registry.js";
import { runPersistenceTokenEconomicsAccounting } from "../src/state/persistence-token-economics.js";

function tier(overrides: Partial<TierConfig> = {}): TierConfig {
  return {
    id: "synesis-core",
    backendModel: "qwen/test",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "test-key",
    inputPerM: 0,
    outputPerM: 0,
    cachedPerM: null,
    cacheWritePerM: null,
    pricingSource: "fallback_base",
    ...overrides,
  };
}

describe("persistence token economics accounting", () => {
  it("centralizes fallback pricing, cache policy state, and provider cache observation", () => {
    const metadata: Record<string, unknown> = {};
    const recordProviderCacheObservation = vi.fn(async () => undefined);
    const logFallbackPricing = vi.fn();

    const result = runPersistenceTokenEconomicsAccounting({
      resolvedModelId: "synesis-core",
      traceModel: "qwen/test",
      tier: tier(),
      metadata,
      orgId: "org-1",
      clientKind: "opencode",
      usage: {
        inputTokens: 4_000,
        outputTokens: 100,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
      optimizationLedger: {
        inputCharsOriginal: 20_000,
        inputCharsFinal: 12_000,
      },
      providerObservationTtlMs: 90_000,
      recordProviderCacheObservation,
      logFallbackPricing,
    });

    expect(result.pricingSource).toBe("fallback_base");
    expect(result.normalizedEstimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(result.normalizedActualCostUsd).toBe(0);
    expect(result.tokenEconomicsDecision).toMatchObject({
      provider: "openrouter",
      cacheOutcome: "miss",
      recommendation: "preserve_stable_prefix_and_investigate",
      estimatedTokensSavedByCompaction: 2_000,
    });
    expect(result.tokenEconomicsMetadata.cache_policy_state).toMatchObject({
      cache_miss_streak: 1,
      last_cache_outcome: "miss",
    });
    expect(metadata.cache_policy_cache_miss_streak).toBe(1);
    expect(recordProviderCacheObservation).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        provider: "openrouter",
        clientKind: "opencode",
        cacheOutcome: "miss",
        promptTokens: 4_000,
        cachedTokens: 0,
      }),
      90_000,
    );
    expect(logFallbackPricing).toHaveBeenCalledWith(expect.objectContaining({
      model: "qwen/test",
      inputTokens: 4_000,
      outputTokens: 100,
      pricingSource: "fallback_base",
    }));
  });

  it("uses provider pricing source when provider actual cost is present", () => {
    const result = runPersistenceTokenEconomicsAccounting({
      resolvedModelId: "synesis-core",
      traceModel: "qwen/test",
      tier: tier({ pricingSource: "manual", inputPerM: 1, outputPerM: 2 }),
      metadata: {},
      orgId: "org-1",
      clientKind: "codex-cli",
      usage: {
        inputTokens: 1_000,
        outputTokens: 50,
        cachedTokens: 500,
        cacheCreationTokens: 0,
        costUsd: 0.123,
      },
      providerObservationTtlMs: 60_000,
      recordProviderCacheObservation: vi.fn(async () => undefined),
    });

    expect(result.pricingSource).toBe("provider");
    expect(result.normalizedActualCostUsd).toBe(0.123);
    expect(result.tokenEconomicsDecision.cacheOutcome).toBe("hit");
  });
});
