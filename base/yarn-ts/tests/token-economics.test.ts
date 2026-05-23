import { describe, expect, it } from "vitest";
import { extractUsage } from "@synesis/telemetry";
import {
  buildTokenEconomicsDecision,
  inferProviderCacheStrategy,
} from "../src/telemetry/token-economics.js";

describe("token economics", () => {
  it("classifies known provider cache strategies", () => {
    expect(inferProviderCacheStrategy("dashscope")).toBe("explicit_premium");
    expect(inferProviderCacheStrategy("anthropic")).toBe("explicit_ephemeral");
    expect(inferProviderCacheStrategy("openrouter")).toBe("implicit_prefix");
    expect(inferProviderCacheStrategy("vllm")).toBe("implicit_prefix");
  });

  it("flags premium cache writes that do not produce reads", () => {
    const decision = buildTokenEconomicsDecision({
      provider: "dashscope",
      tier: "synesis-core",
      model: "qwen-plus",
      promptTokens: 8_000,
      completionTokens: 200,
      cachedTokens: 0,
      cacheCreationTokens: 3_000,
    });

    expect(decision.strategy).toBe("explicit_premium");
    expect(decision.cacheOutcome).toBe("write_without_read");
    expect(decision.recommendation).toBe("disable_premium_cache_write");
    expect(decision.warnings).toContain("premium_cache_write_without_read");
  });

  it("treats reported cache reads as healthy", () => {
    const decision = buildTokenEconomicsDecision({
      provider: "openrouter",
      tier: "synesis-core",
      model: "qwen",
      promptTokens: 10_000,
      completionTokens: 100,
      cachedTokens: 7_500,
      cacheCreationTokens: 0,
    });

    expect(decision.cacheOutcome).toBe("hit");
    expect(decision.cacheHitPct).toBe(75);
    expect(decision.recommendation).toBe("cache_healthy");
    expect(decision.warnings).toEqual([]);
  });

  it("warns when compaction savings are unproven without a cache hit", () => {
    const decision = buildTokenEconomicsDecision({
      provider: "vllm",
      tier: "synesis-core",
      model: "qwen",
      promptTokens: 4_000,
      completionTokens: 100,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      inputCharsOriginal: 20_000,
      inputCharsFinal: 12_000,
    });

    expect(decision.estimatedTokensSavedByCompaction).toBe(2_000);
    expect(decision.warnings).toContain("compaction_savings_unproven_without_cache_hit");
    expect(decision.recommendation).toBe("preserve_stable_prefix_and_investigate");
  });

  it("normalizes cache creation tokens nested under prompt token details", () => {
    const usage = extractUsage({
      prompt_tokens: 5_000,
      completion_tokens: 100,
      prompt_tokens_details: {
        cached_tokens: 2_500,
        cache_creation_input_tokens: 1_500,
      },
    });

    expect(usage.cached_prompt_tokens).toBe(2_500);
    expect(usage.cache_creation_tokens).toBe(1_500);
  });

  it("normalizes DeepSeek prompt cache hit tokens", () => {
    const usage = extractUsage({
      completion_tokens: 120,
      prompt_cache_hit_tokens: 9_500,
      prompt_cache_miss_tokens: 2_500,
    });

    expect(usage.prompt_tokens).toBe(12_000);
    expect(usage.cached_prompt_tokens).toBe(9_500);
  });
});
