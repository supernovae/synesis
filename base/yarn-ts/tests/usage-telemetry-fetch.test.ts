import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageTelemetryFetch } from "../src/providers/usage-telemetry-fetch.js";
import {
  buildCacheDebugRequestSnapshot,
  resetCacheDebugTraceState,
} from "../src/telemetry/cache-debug-trace.js";

describe("createUsageTelemetryFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCacheDebugTraceState();
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

  it("emits hashed cache debug traces without prompt text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const wrapped = createUsageTelemetryFetch(
      async () => new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [],
        usage: {
          prompt_tokens: 8_000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      {
        provider: "openrouter",
        tier: "synesis-core",
        model: "qwen/test",
        cacheDebugTraceMode: "hashed",
        getCacheDebugTraceContext: () => ({
          sessionKey: "session-secret",
          requestId: "req-1",
          clientKind: "opencode",
        }),
      },
    );
    const stableSystem = `SECRET_PROMPT_DO_NOT_LOG\n${"stable rule\n".repeat(500)}`;

    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: stableSystem },
          { role: "user", content: "first turn" },
        ],
      }),
    });

    const serializedLogs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(serializedLogs).not.toContain("SECRET_PROMPT_DO_NOT_LOG");
    expect(serializedLogs).not.toContain("stable rule");
    expect(serializedLogs).not.toContain("first turn");
    const snapshot = buildCacheDebugRequestSnapshot(JSON.stringify({
      stream: false,
      messages: [
        { role: "system", content: stableSystem },
        { role: "user", content: "first turn" },
      ],
    }));
    expect(snapshot).not.toHaveProperty("payload");
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_PROMPT_DO_NOT_LOG");
    expect(JSON.stringify(snapshot)).not.toContain("first turn");
    const trace = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((record) => record.msg === "provider_cache_debug_trace");
    expect(trace).toMatchObject({
      schema_version: "provider_cache_debug_trace_v1",
      provider: "openrouter",
      tier: "synesis-core",
      model: "qwen/test",
      request_id: "req-1",
      client_kind: "opencode",
      prompt_tokens: 8_000,
      cached_tokens: 0,
      cache_miss_reason: "first_request",
    });
    expect(trace?.session_key_hash).not.toBe("session-secret");
    expect(Array.isArray(trace?.first_message_hashes)).toBe(true);
  });

  it("classifies high-stability zero-cache follow-up as provider routing or ttl", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let requestId = "req-1";
    const wrapped = createUsageTelemetryFetch(
      async () => new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [],
        usage: {
          prompt_tokens: 8_000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      {
        provider: "openrouter",
        tier: "synesis-core",
        model: "qwen/test",
        cacheDebugTraceMode: "hashed",
        getCacheDebugTraceContext: () => ({
          sessionKey: "stable-session",
          requestId,
          clientKind: "codex-cli",
        }),
      },
    );
    const stableSystem = "stable-prefix\n".repeat(500);

    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: stableSystem },
          { role: "user", content: "first turn" },
        ],
      }),
    });
    requestId = "req-2";
    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: stableSystem },
          { role: "user", content: "second turn" },
        ],
      }),
    });

    const traces = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((record) => record.msg === "provider_cache_debug_trace");
    expect(traces).toHaveLength(2);
    expect(traces[1]).toMatchObject({
      request_id: "req-2",
      cache_miss_reason: "provider_cache_ttl_or_routing",
    });
    expect(Number(traces[1]?.shared_prefix_bytes)).toBeGreaterThan(4_000);
    expect(Number(traces[1]?.first_divergence_message_index)).toBe(1);
  });

  it("classifies volatile system-prefix changes without retaining request payload text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let requestId = "req-1";
    const wrapped = createUsageTelemetryFetch(
      async () => new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [],
        usage: {
          prompt_tokens: 8_000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      {
        provider: "openrouter",
        tier: "synesis-core",
        model: "qwen/test",
        cacheDebugTraceMode: "hashed",
        getCacheDebugTraceContext: () => ({
          sessionKey: "volatile-session",
          requestId,
          clientKind: "codex-cli",
        }),
      },
    );

    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: `Current date: 2026-06-08\n${"stable rule\n".repeat(500)}` },
          { role: "user", content: "first turn" },
        ],
      }),
    });
    requestId = "req-2";
    await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: "system", content: `Current date: 2026-06-09\n${"stable rule\n".repeat(500)}` },
          { role: "user", content: "second turn" },
        ],
      }),
    });

    const serializedLogs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(serializedLogs).not.toContain("Current date: 2026-06-08");
    expect(serializedLogs).not.toContain("Current date: 2026-06-09");
    const traces = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((record) => record.msg === "provider_cache_debug_trace");
    expect(traces[1]).toMatchObject({
      request_id: "req-2",
      cache_miss_reason: "volatile_metadata_in_prefix",
    });
  });
});
