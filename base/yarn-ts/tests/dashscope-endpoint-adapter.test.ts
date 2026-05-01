import { describe, expect, it, vi } from "vitest";
import { composeEndpointTransportFetch } from "../src/providers/endpoint-capabilities/compose-fetch.js";
import { createDashScopeEndpointAdapter } from "../src/providers/endpoint-capabilities/dashscope.js";
import { resolveEndpointCapabilityId } from "../src/providers/endpoint-capabilities/resolve.js";

function largeSystemMessages() {
  return [
    { role: "system", content: "core ".repeat(1200) },
    { role: "system", content: "project ".repeat(1200) },
    { role: "user", content: "fix auth" },
  ];
}

describe("DashScope endpoint adapter", () => {
  it("detects DashScope endpoint URLs", () => {
    expect(resolveEndpointCapabilityId("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("dashscope");
    expect(resolveEndpointCapabilityId("https://dashscope-us.aliyuncs.com/compatible-mode/v1")).toBe("dashscope");
    expect(resolveEndpointCapabilityId("https://openrouter.ai/api/v1")).toBe("openrouter");
  });

  it("does not inject markers when disabled", async () => {
    const adapter = createDashScopeEndpointAdapter({ mode: "off", canaryPct: 100, maxMarkers: 3 });
    const captured: { body?: string } = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response("{}");
    });
    const fetch = composeEndpointTransportFetch(
      fetchMock as unknown as typeof globalThis.fetch,
      adapter,
      () => "session-a",
      { getMarkerIndices: () => [1], retryPolicy: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } },
    );

    const body = JSON.stringify({ messages: largeSystemMessages(), tools: [{ type: "function", function: { name: "Read" } }] });
    await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", { method: "POST", body });

    const parsed = JSON.parse(captured.body!);
    expect(parsed.messages[1].content).toBe("project ".repeat(1200));
    expect(parsed.tools[0].cache_control).toBeUndefined();
  });

  it("injects explicit cache markers at optimizer-provided stable indices when enabled", async () => {
    const adapter = createDashScopeEndpointAdapter({ mode: "auto", canaryPct: 0, maxMarkers: 3 });
    const captured: { body?: string } = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response("{}");
    });
    const fetch = composeEndpointTransportFetch(
      fetchMock as unknown as typeof globalThis.fetch,
      adapter,
      () => "session-a",
      { getMarkerIndices: () => [1], retryPolicy: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } },
    );

    const body = JSON.stringify({ messages: largeSystemMessages(), tools: [{ type: "function", function: { name: "Read" } }] });
    await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", { method: "POST", body });

    const parsed = JSON.parse(captured.body!);
    expect(Array.isArray(parsed.messages[1].content)).toBe(true);
    expect(parsed.messages[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.messages[0].content).toBe("core ".repeat(1200));
    expect(parsed.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places markers on the actual outbound leading-system boundary when provider transforms shift indices", async () => {
    const adapter = createDashScopeEndpointAdapter({ mode: "auto", canaryPct: 0, maxMarkers: 3 });
    const captured: { body?: string } = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response("{}");
    });
    const fetch = composeEndpointTransportFetch(
      fetchMock as unknown as typeof globalThis.fetch,
      adapter,
      () => "session-a",
      { getMarkerIndices: () => [1], retryPolicy: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } },
    );

    const body = JSON.stringify({
      messages: [
        { role: "system", content: "adapter ".repeat(1200) },
        ...largeSystemMessages(),
      ],
    });
    await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", { method: "POST", body });

    const parsed = JSON.parse(captured.body!);
    expect(parsed.messages[1].content).toBe("core ".repeat(1200));
    expect(Array.isArray(parsed.messages[2].content)).toBe(true);
    expect(parsed.messages[2].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips markers when the selected prefix is below provider minimum size", async () => {
    const adapter = createDashScopeEndpointAdapter({ mode: "auto", canaryPct: 0, maxMarkers: 3 });
    const captured: { body?: string } = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = init?.body as string;
      return new Response("{}");
    });
    const fetch = composeEndpointTransportFetch(
      fetchMock as unknown as typeof globalThis.fetch,
      adapter,
      () => "session-a",
      { getMarkerIndices: () => [0], retryPolicy: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } },
    );

    const body = JSON.stringify({ messages: [{ role: "system", content: "tiny" }, { role: "user", content: "hello" }] });
    await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", { method: "POST", body });

    const parsed = JSON.parse(captured.body!);
    expect(parsed.messages[0].content).toBe("tiny");
  });
});
