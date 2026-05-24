import { describe, expect, it, vi } from "vitest";
import { createClaudeStreamProviderRequestOptions } from "../src/streaming/claude-stream-provider-request.js";

describe("createClaudeStreamProviderRequestOptions", () => {
  it("builds AI SDK request options for streaming Claude calls", () => {
    const abortController = new AbortController();
    const clampMaxOutputTokens = vi.fn((tokens: number) => Math.min(tokens, 1024));

    const options = createClaudeStreamProviderRequestOptions({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 512,
      requestMaxTokens: 2048,
      samplingOptions: { temperature: 0.2, topP: 0.9 },
      stopSequences: ["stop"],
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
      clampMaxOutputTokens,
    });

    expect(clampMaxOutputTokens).toHaveBeenCalledWith(2048);
    expect(options).toMatchObject({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 1024,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["stop"],
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    });
    expect(options.abortSignal).toBe(abortController.signal);
  });

  it("uses orchestration max when client max tokens are absent", () => {
    const abortController = new AbortController();
    const options = createClaudeStreamProviderRequestOptions({
      model: "model-a",
      messages: [],
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 300,
      requestMaxTokens: null,
      clampMaxOutputTokens: (tokens) => tokens,
    });

    expect(options).toEqual({
      model: "model-a",
      messages: [],
      abortSignal: abortController.signal,
      maxOutputTokens: 300,
    });
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("providerOptions");
  });
});
