import { describe, expect, it } from "vitest";
import {
  evaluateCachePolicyController,
  updateCachePolicyStateFromTokenEconomics,
} from "../src/telemetry/cache-policy-controller.js";
import { buildTokenEconomicsDecision } from "../src/telemetry/token-economics.js";

const baseInput = {
  enabled: true,
  provider: "dashscope",
  configuredCompactionMode: "minimal" as const,
  missStreakThreshold: 2,
  telemetryMissingThreshold: 2,
  premiumWriteWithoutReadThreshold: 2,
  retryRiskStagnantCycles: 2,
  stagnantToolCycles: 0,
  awaitingToolLoopUserAck: false,
  toolLoopNoUserAckCount: 0,
  consecutiveRecoveryFires: 0,
  consecutiveEditContextMisses: 0,
};

describe("cache policy controller", () => {
  it("preserves cache when provider hits are observed", () => {
    const metadata: Record<string, unknown> = {};
    updateCachePolicyStateFromTokenEconomics(metadata, buildTokenEconomicsDecision({
      provider: "openrouter",
      tier: "synesis-core",
      model: "qwen",
      promptTokens: 10_000,
      completionTokens: 100,
      cachedTokens: 8_000,
      cacheCreationTokens: 0,
    }));

    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata,
      provider: "openrouter",
      configuredCompactionMode: "aggressive",
    });

    expect(decision.action).toBe("preserve_cache");
    expect(decision.compactionMode).toBe("minimal");
    expect(decision.allowExplicitCacheMarkers).toBe(true);
  });

  it("switches to safe efficiency when caching is unavailable and the flow is stable", () => {
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < 2; i += 1) {
      updateCachePolicyStateFromTokenEconomics(metadata, buildTokenEconomicsDecision({
        provider: "vllm",
        tier: "synesis-core",
        model: "qwen",
        promptTokens: 12_000,
        completionTokens: 100,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      }));
    }

    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata,
      provider: "vllm",
    });

    expect(decision.cacheUnavailable).toBe(true);
    expect(decision.retryLoopRisk).toBe(false);
    expect(decision.action).toBe("safe_efficiency");
    expect(decision.compactionMode).toBe("aggressive");
  });

  it("backs off efficiency when retry-loop risk is present", () => {
    const metadata: Record<string, unknown> = {
      cache_policy_cache_miss_streak: 3,
    };

    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata,
      provider: "vllm",
      stagnantToolCycles: 2,
    });

    expect(decision.cacheUnavailable).toBe(true);
    expect(decision.retryLoopRisk).toBe(true);
    expect(decision.action).toBe("safety_backoff");
    expect(decision.compactionMode).toBe("minimal");
  });

  it("suppresses premium cache markers after repeated writes without reads", () => {
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < 2; i += 1) {
      updateCachePolicyStateFromTokenEconomics(metadata, buildTokenEconomicsDecision({
        provider: "dashscope",
        tier: "synesis-core",
        model: "qwen-plus",
        promptTokens: 8_000,
        completionTokens: 100,
        cachedTokens: 0,
        cacheCreationTokens: 4_000,
      }));
    }

    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata,
      provider: "dashscope",
    });

    expect(decision.premiumCacheWriteSuppressed).toBe(true);
    expect(decision.allowExplicitCacheMarkers).toBe(false);
    expect(decision.reasons).toContain("premium_cache_write_without_read_streak");
  });

  it("uses longer-window provider observations to preserve known-good cache hits", () => {
    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata: { cache_policy_cache_miss_streak: 3 },
      provider: "openrouter",
      providerWindowMinRequests: 4,
      providerWindow: {
        windowHours: 24,
        requests: 12,
        hits: 9,
        misses: 3,
        writeWithoutRead: 0,
        telemetryMissing: 0,
        promptTokens: 120_000,
        cachedPromptTokens: 80_000,
        cacheCreationTokens: 0,
        cacheHitPct: 66.67,
        telemetryMissingPct: 0,
        writeWithoutReadPct: 0,
      },
      runtimePreferences: { cachePolicyBias: "cache_first", allowAggressiveCompactionWithoutCacheHits: true },
    });

    expect(decision.action).toBe("preserve_cache");
    expect(decision.compactionMode).toBe("minimal");
    expect(decision.reasons).toContain("provider_window_cache_hit_observed");
  });

  it("uses longer-window provider misses to move to safe efficiency when loop risk is absent", () => {
    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata: {},
      provider: "vllm",
      providerWindowMinRequests: 4,
      providerWindow: {
        windowHours: 24,
        requests: 9,
        hits: 0,
        misses: 9,
        writeWithoutRead: 0,
        telemetryMissing: 0,
        promptTokens: 90_000,
        cachedPromptTokens: 0,
        cacheCreationTokens: 0,
        cacheHitPct: 0,
        telemetryMissingPct: 0,
        writeWithoutReadPct: 0,
      },
    });

    expect(decision.cacheUnavailable).toBe(true);
    expect(decision.action).toBe("safe_efficiency");
    expect(decision.compactionMode).toBe("aggressive");
    expect(decision.reasons).toContain("provider_window_cache_unavailable_or_unreported");
  });

  it("honors a user cache-first preference when cache misses are not proven across the provider window", () => {
    const decision = evaluateCachePolicyController({
      ...baseInput,
      metadata: { cache_policy_cache_miss_streak: 2 },
      provider: "openrouter",
      runtimePreferences: { cachePolicyBias: "cache_first", allowAggressiveCompactionWithoutCacheHits: false },
    });

    expect(decision.action).toBe("preserve_cache");
    expect(decision.compactionMode).toBe("minimal");
    expect(decision.reasons).toContain("user_prefers_cache_first_until_proven");
  });
});
