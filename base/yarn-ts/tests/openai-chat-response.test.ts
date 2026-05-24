import { describe, expect, it } from "vitest";
import { buildOpenAIChatCompletionResponse } from "../src/pipeline/openai-chat-response.js";

describe("buildOpenAIChatCompletionResponse", () => {
  it("builds the OpenAI-compatible non-stream chat completion envelope", () => {
    const response = buildOpenAIChatCompletionResponse({
      id: "chatcmpl-test",
      model: "model-1",
      created: 123,
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 3,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    });

    expect(response).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 123,
      model: "model-1",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cached_prompt_tokens: 3,
        cache_creation_tokens: 0,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
  });
});
