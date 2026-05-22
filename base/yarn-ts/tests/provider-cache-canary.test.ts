import { describe, expect, it } from "vitest";
import {
  runProviderCacheCanaries,
  summarizeProviderCacheCanaries,
} from "../src/telemetry/provider-cache-canary.js";

describe("provider cache canaries", () => {
  it("passes offline provider cache contracts", () => {
    const results = runProviderCacheCanaries();
    const summary = summarizeProviderCacheCanaries(results);

    expect(summary, JSON.stringify(summary.failures, null, 2)).toMatchObject({
      passed: true,
      total: 6,
      failed: 0,
    });

    const dashscope = results.find((result) => result.id === "dashscope");
    expect(dashscope?.markerIndicesSecond.length).toBeGreaterThan(0);
    expect(dashscope?.annotations.dashscopeMessageMarkers).toBeGreaterThan(0);
    expect(dashscope?.annotations.dashscopeToolMarkers).toBeGreaterThan(0);
    expect(dashscope?.decisions.writeWithoutRead?.recommendation).toBe("disable_premium_cache_write");

    const anthropic = results.find((result) => result.id === "anthropic");
    expect(anthropic?.markerIndicesSecond.length).toBeGreaterThan(0);
    expect(anthropic?.annotations.anthropicBreakpoints).toBeGreaterThan(0);

    const implicitProviders = results.filter((result) =>
      ["openai-compatible", "openrouter", "deepseek", "vllm"].includes(result.id)
    );
    expect(implicitProviders.every((result) => result.markerIndicesSecond.length === 0)).toBe(true);
    expect(implicitProviders.every((result) => result.prefixStableBytes >= 8_000)).toBe(true);
    expect(implicitProviders.every((result) => result.decisions.miss.recommendation === "preserve_stable_prefix_and_investigate")).toBe(true);
  });
});
