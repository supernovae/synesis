import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageTelemetryFetch } from "../src/providers/usage-telemetry-fetch.js";

describe("createUsageTelemetryFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits token economics telemetry for non-streaming JSON responses", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wrapped = createUsageTelemetryFetch(
      async () => new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [],
        usage: {
          prompt_tokens: 4_000,
          completion_tokens: 100,
          prompt_tokens_details: {
            cached_tokens: 1_000,
            cache_creation_input_tokens: 2_000,
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      {
        provider: "dashscope",
        tier: "synesis-core",
        model: "qwen-plus",
      },
    );

    const response = await wrapped("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }] },
          { role: "user", content: "hello" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).usage.prompt_tokens).toBe(4_000);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record.msg).toBe("llm_usage_telemetry");
    expect(record.source).toBe("non_stream");
    expect(record.cache_marker_count).toBe(1);
    expect(record.cache_hit_pct).toBe(25);
    expect(record.token_economics).toMatchObject({
      strategy: "explicit_premium",
      cache_outcome: "hit",
      recommendation: "cache_healthy",
      cache_creation_tokens: 2_000,
    });
  });

  it("preserves non-streaming malformed JSON responses without telemetry", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wrapped = createUsageTelemetryFetch(
      async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      {
        provider: "generic",
        tier: "synesis-core",
        model: "model",
      },
    );

    const response = await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: false, messages: [] }),
    });

    expect(await response.text()).toBe("not-json");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
