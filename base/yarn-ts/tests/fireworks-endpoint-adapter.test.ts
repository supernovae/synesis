import { describe, expect, it } from "vitest";
import { createFireworksEndpointAdapter } from "../src/providers/endpoint-capabilities/fireworks.js";

describe("createFireworksEndpointAdapter", () => {
  const adapter = createFireworksEndpointAdapter();

  it("merges cached prompt tokens from response headers into non-stream JSON", async () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], stream: false }),
    };
    const response = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "fireworks-cached-prompt-tokens": "820",
        "fireworks-prompt-tokens": "1000",
      },
    });
    const out = await adapter.transformResponse(response, init);
    const json = (await out.json()) as {
      usage: { prompt_tokens_details: { cached_tokens: number }; prompt_tokens: number };
    };
    expect(json.usage.prompt_tokens_details.cached_tokens).toBe(820);
    expect(json.usage.prompt_tokens).toBe(1000);
  });

  it("does not rewrite streaming responses", async () => {
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    };
    const response = new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await adapter.transformResponse(response, init);
    expect(out).toBe(response);
  });
});
