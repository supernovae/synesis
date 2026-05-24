import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamProviderRequestOptions,
  prepareClaudeStreamProviderRequest,
} from "../src/streaming/claude-stream-provider-request.js";

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

  it("repairs orphaned tool-call pairs before building stream request options", () => {
    const abortController = new AbortController();
    const logger = { warn: vi.fn() };
    const recordSessionEvent = vi.fn();

    const result = prepareClaudeStreamProviderRequest({
      requestId: "req_1",
      model: "model-a",
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "Read", arguments: "{}" } }],
      }],
      adapter: { family: "openai", supportsThinking: true },
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 256,
      requestMaxTokens: null,
      clampMaxOutputTokens: (tokens) => tokens,
      logger,
      recordSessionEvent,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "Read",
    });
    expect(result.options.messages).toBe(result.messages);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "req_1",
      orphanedToolCallIds: ["call_1"],
    }), "tool_pair_integrity_repair_applied");
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "tool_pair_integrity_repaired",
      component: "validation",
      detail: "orphaned=1 ids=call_1",
    });
  });

  it("removes unsupported OpenAI thinking provider options for stream calls", () => {
    const abortController = new AbortController();

    const result = prepareClaudeStreamProviderRequest({
      requestId: "req_1",
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      adapter: { family: "openai", supportsThinking: false },
      abortSignal: abortController.signal,
      orchestrationMaxOutputTokens: 256,
      requestMaxTokens: null,
      providerOptions: {
        openai: {
          thinking: { type: "enabled" },
          enable_thinking: true,
          reasoningEffort: "low",
        },
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
      clampMaxOutputTokens: (tokens) => tokens,
      logger: { warn: vi.fn() },
      recordSessionEvent: vi.fn(),
    });

    expect(result.providerOptions).toEqual({
      openai: { reasoningEffort: "low" },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(result.options.providerOptions).toEqual(result.providerOptions);
  });
});
