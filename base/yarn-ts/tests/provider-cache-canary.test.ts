import { describe, expect, it } from "vitest";
import {
  runProviderCacheCanaries,
  runProviderCacheLiveCanaries,
  summarizeProviderCacheCanaries,
  summarizeProviderCacheLiveCanaries,
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

  it("skips live canaries unless explicitly enabled and acknowledged", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    const disabled = await runProviderCacheLiveCanaries({
      enabled: false,
      costAck: false,
      allowedProviderIds: ["openrouter"],
      endpoints: { openrouter: { baseUrl: "https://example.invalid/v1", apiKey: "test" } },
      fetchImpl: fakeFetch,
    });
    expect(disabled.every((result) => result.status === "skipped")).toBe(true);
    expect(disabled.every((result) => result.reason === "live_disabled")).toBe(true);

    const missingAck = await runProviderCacheLiveCanaries({
      enabled: true,
      costAck: false,
      allowedProviderIds: ["openrouter"],
      endpoints: { openrouter: { baseUrl: "https://example.invalid/v1", apiKey: "test" } },
      fetchImpl: fakeFetch,
    });
    const openrouter = missingAck.find((result) => result.id === "openrouter");
    expect(openrouter?.status).toBe("skipped");
    expect(openrouter?.reason).toBe("cost_ack_required");
    expect(calls).toBe(0);
  });

  it("runs an allowed live OpenAI-compatible probe with injected fetch", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      seenBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const usage = seenBodies.length === 1
        ? { prompt_tokens: 8_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }
        : { prompt_tokens: 8_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 6_000 } };
      return new Response(JSON.stringify({ id: "cmpl-test", choices: [], usage }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const results = await runProviderCacheLiveCanaries({
      enabled: true,
      costAck: true,
      allowedProviderIds: ["openrouter"],
      endpoints: { openrouter: { baseUrl: "https://example.invalid/v1", apiKey: "test", model: "qwen/test" } },
      fetchImpl: fakeFetch,
      requireCacheHit: true,
    });
    const summary = summarizeProviderCacheLiveCanaries(results);
    const openrouter = results.find((result) => result.id === "openrouter");

    expect(summary.failed).toBe(0);
    expect(openrouter?.status).toBe("passed");
    expect(openrouter?.cacheHitPct).toBe(75);
    expect(openrouter?.cachedPromptTokens).toBe(6_000);
    expect(openrouter?.recommendation).toBe("cache_healthy");
    expect(seenBodies).toHaveLength(2);
    expect(seenBodies[0]?.model).toBe("qwen/test");
  });

  it("fails live probes when cache hits are required but absent", async () => {
    const fakeFetch: typeof fetch = async () => (
      new Response(JSON.stringify({
        id: "cmpl-test",
        choices: [],
        usage: { prompt_tokens: 8_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const results = await runProviderCacheLiveCanaries({
      enabled: true,
      costAck: true,
      allowedProviderIds: ["openrouter"],
      endpoints: { openrouter: { baseUrl: "https://example.invalid/v1", apiKey: "test" } },
      fetchImpl: fakeFetch,
      requireCacheHit: true,
    });
    const openrouter = results.find((result) => result.id === "openrouter");

    expect(openrouter?.status).toBe("failed");
    expect(openrouter?.failures).toContain("required_cache_hit_missing:miss");
    expect(openrouter?.warnings).toContain("cache_hit_unverified:miss");
  });
});
