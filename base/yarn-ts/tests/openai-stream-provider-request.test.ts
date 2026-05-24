import { describe, expect, it, vi } from "vitest";
import { createOpenAIStreamProviderRequestOptions } from "../src/streaming/openai-stream-provider-request.js";

describe("createOpenAIStreamProviderRequestOptions", () => {
  it("builds AI SDK request options for streaming OpenAI calls", () => {
    const abortController = new AbortController();
    const clampMaxOutputTokens = vi.fn((tokens: number) => Math.min(tokens, 1024));

    const options = createOpenAIStreamProviderRequestOptions({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 512,
      requestMaxTokens: 2048,
      output: { type: "json" },
      samplingOptions: { temperature: 0.2, topP: 0.9 },
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { openai: { reasoningEffort: "low" } },
      clampMaxOutputTokens,
    });

    expect(clampMaxOutputTokens).toHaveBeenCalledWith(2048);
    expect(options).toMatchObject({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 1024,
      temperature: 0.2,
      topP: 0.9,
      output: { type: "json" },
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    expect(options.abortSignal).toBe(abortController.signal);
  });

  it("uses max_completion_tokens fallback and omits absent optional fields", () => {
    const abortController = new AbortController();
    const options = createOpenAIStreamProviderRequestOptions({
      model: "model-a",
      messages: [],
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 300,
      requestMaxTokens: null,
      requestMaxCompletionTokens: 700,
      clampMaxOutputTokens: (tokens) => tokens,
    });

    expect(options).toEqual({
      model: "model-a",
      messages: [],
      abortSignal: abortController.signal,
      maxOutputTokens: 700,
    });
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("providerOptions");
  });
});
