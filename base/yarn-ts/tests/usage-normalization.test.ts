import { describe, expect, it, vi } from "vitest";

import { normalizeProviderUsage } from "../src/telemetry/usage-normalization.js";

describe("normalizeProviderUsage", () => {
  it("reads Vercel AI SDK shape", () => {
    expect(normalizeProviderUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      costUsd: 0.01,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      cacheCreationTokens: 0,
      costUsd: 0.01,
    });
  });

  it("reads OpenAI-compatible prompt token details", () => {
    expect(normalizeProviderUsage({
      input_tokens: 200,
      output_tokens: 80,
      prompt_tokens_details: {
        cached_tokens: 40,
        cache_creation_input_tokens: 12,
      },
    })).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
      cachedTokens: 40,
      cacheCreationTokens: 12,
    });
  });

  it("reads snake_case prompt/completion token fields", () => {
    expect(normalizeProviderUsage({ prompt_tokens: 320, completion_tokens: 90 })).toMatchObject({
      inputTokens: 320,
      outputTokens: 90,
    });
  });

  it("reads Anthropic and vLLM cache token variants", () => {
    expect(normalizeProviderUsage({ inputTokens: 300, outputTokens: 100, cache_read_input_tokens: 60 }).cachedTokens).toBe(60);
    expect(normalizeProviderUsage({ inputTokens: 300, outputTokens: 100, prefix_cache_hit_tokens: 61 }).cachedTokens).toBe(61);
    expect(normalizeProviderUsage({ inputTokens: 300, outputTokens: 100, num_cached_tokens: 62 }).cachedTokens).toBe(62);
  });

  it("reads DeepSeek cache hit/miss shape", () => {
    expect(normalizeProviderUsage({
      outputTokens: 10,
      prompt_cache_hit_tokens: 77,
      prompt_cache_miss_tokens: 23,
    })).toMatchObject({
      inputTokens: 100,
      cachedTokens: 77,
    });
  });

  it("reads input token detail cache read/write fields", () => {
    expect(normalizeProviderUsage({
      inputTokens: 300,
      outputTokens: 10,
      inputTokenDetails: {
        cacheReadTokens: 88,
        cacheWriteTokens: 11,
      },
    })).toMatchObject({
      cachedTokens: 88,
      cacheCreationTokens: 11,
    });
  });

  it("handles null/undefined input gracefully", () => {
    expect(normalizeProviderUsage(null).inputTokens).toBe(0);
    expect(normalizeProviderUsage(undefined).cachedTokens).toBe(0);
    expect(normalizeProviderUsage({}).costUsd).toBe(0);
  });

  it("can log raw usage in debug mode", () => {
    const debug = vi.fn();

    normalizeProviderUsage({ inputTokens: 1 }, { debug: true, logger: { debug } });

    expect(debug).toHaveBeenCalledWith({ rawUsage: { inputTokens: 1 } }, "raw_usage_from_sdk");
  });
});
