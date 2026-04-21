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
});

describe("detectCacheStrategy + Fireworks", () => {
  it("returns implicit_prefix for Fireworks base URL", () => {
    expect(detectCacheStrategy("https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/llama")).toBe(
      "implicit_prefix",
    );
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
});
