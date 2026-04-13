import { describe, expect, it } from "vitest";
import { shouldIncludeStreamUsage, toOpenAiUsage } from "../src/openai-compat.js";

describe("openai compatibility helpers", () => {
  it("maps internal usage shape to OpenAI usage keys", () => {
    const usage = toOpenAiUsage({
      inputTokens: 120,
      outputTokens: 45,
      cachedTokens: 30,
      cacheCreationTokens: 5,
    });
    expect(usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
      prompt_tokens_details: {
        cached_tokens: 30,
      },
      cached_prompt_tokens: 30,
      cache_creation_tokens: 5,
    });
  });

  it("defaults stream usage inclusion to true", () => {
    expect(shouldIncludeStreamUsage(undefined)).toBe(true);
    expect(shouldIncludeStreamUsage({})).toBe(true);
    expect(shouldIncludeStreamUsage({ include_usage: "nope" })).toBe(true);
  });

  it("honors stream_options.include_usage=false", () => {
    expect(shouldIncludeStreamUsage({ include_usage: false })).toBe(false);
    expect(shouldIncludeStreamUsage({ include_usage: true })).toBe(true);
  });
});
