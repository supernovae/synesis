import { describe, expect, it } from "vitest";
import { resolveEndpointCapabilityId } from "../src/providers/endpoint-capabilities/resolve.js";
import { getEndpointTransportAdapter } from "../src/providers/endpoint-capabilities/registry.js";
import { composeEndpointTransportFetch } from "../src/providers/endpoint-capabilities/compose-fetch.js";
import { detectCacheStrategy } from "../src/context/provider-cache-hints.js";

describe("resolveEndpointCapabilityId", () => {
  it("classifies Fireworks", () => {
    expect(resolveEndpointCapabilityId("https://api.fireworks.ai/inference/v1")).toBe("fireworks");
  });
  it("classifies OpenRouter", () => {
    expect(resolveEndpointCapabilityId("https://openrouter.ai/api/v1")).toBe("openrouter");
  });
  it("classifies vLLM-style hosts", () => {
    expect(resolveEndpointCapabilityId("http://localhost:8000/v1")).toBe("vllm");
    expect(resolveEndpointCapabilityId("https://my-runpod.net/v1")).toBe("vllm");
  });
  it("defaults to generic", () => {
    expect(resolveEndpointCapabilityId("https://api.openai.com/v1")).toBe("generic");
  });
  it("classifies Kimi Code (coding) API", () => {
    expect(resolveEndpointCapabilityId("https://api.kimi.com/coding/v1")).toBe("kimi_coding");
  });
  it("classifies DeepSeek API", () => {
    expect(resolveEndpointCapabilityId("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(getEndpointTransportAdapter("deepseek").telemetryProviderTag).toBe("deepseek");
  });
});

describe("detectCacheStrategy + Fireworks", () => {
  it("returns implicit_prefix for Fireworks base URL", () => {
    expect(detectCacheStrategy("https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/llama")).toBe(
      "implicit_prefix",
    );
  });

  it("uses model capability presets when model names are provider-opaque", () => {
    expect(detectCacheStrategy("https://crof.example/v1", "v4-pro", "deepseek_v4")).toBe("deepseek_auto");
    expect(detectCacheStrategy("https://mixed.example/v1", "served-123", "kimi_k2")).toBe("implicit_prefix");
  });
});

describe("composeEndpointTransportFetch", () => {
  it("invokes native fetch with augmented init for Fireworks", async () => {
    const adapter = getEndpointTransportAdapter("fireworks");
    let seenHeaders: Headers | undefined;
    const nativeFetch: typeof fetch = async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const wrapped = composeEndpointTransportFetch(nativeFetch, adapter, () => "sess-abc");
    await wrapped("https://api.fireworks.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(seenHeaders?.get("x-session-affinity")).toBe("sess-abc");
  });

  it("does not set affinity for generic adapter", async () => {
    const adapter = getEndpointTransportAdapter("generic");
    let seenHeaders: Headers | undefined;
    const nativeFetch: typeof fetch = async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const wrapped = composeEndpointTransportFetch(nativeFetch, adapter, () => "sess-xyz");
    await wrapped("https://example.com/v1", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(seenHeaders?.get("x-session-affinity")).toBeNull();
  });

  it("sets User-Agent for Kimi Coding adapter (subscription / coding-agent gate)", async () => {
    const adapter = getEndpointTransportAdapter("kimi_coding");
    let seenHeaders: Headers | undefined;
    const nativeFetch: typeof fetch = async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const wrapped = composeEndpointTransportFetch(nativeFetch, adapter, () => null);
    await wrapped("https://api.kimi.com/coding/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "kimi-for-coding", messages: [] }),
    });
    expect(seenHeaders?.get("user-agent")).toBe("claude-code/0.1.0");
  });
});
