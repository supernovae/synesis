import { describe, expect, it, vi } from "vitest";

import { runClaudeStreamKickoffPipeline } from "../src/streaming/claude-stream-kickoff-pipeline.js";
import type { StreamTokenUsage } from "../src/streaming/openai-stream-finalizer.js";

const usage: StreamTokenUsage = {
  inputTokens: 3,
  outputTokens: 5,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

function createInput(overrides: Partial<Parameters<typeof runClaudeStreamKickoffPipeline>[0]> = {}) {
  const events: Array<{ event: string; data: unknown }> = [];
  const ended = vi.fn();
  return {
    events,
    input: {
      model: "claude-test",
      headers: { "content-type": "text/event-stream" },
      providerInput: {
        initialMessages: [{ role: "user", content: "hello" }],
        model: "model",
        resolvedModelId: "claude-test",
        orchestrationMaxOutputTokens: 128,
        phasePolicy: { active: false },
        governorPhase: "edit",
        nativeWebSearchRequested: false,
        clampMaxOutputTokens: (tokens: number) => tokens,
        generateText: vi.fn(async () => ({
          text: "done",
          usage: {},
          toolCalls: [],
        })),
        readUsage: vi.fn(() => usage),
        captureForensics: vi.fn(() => ({ record: {}, serialized: "{}" })),
        finalizeForensics: vi.fn(() => ({ summary: "same-prefix" })),
        recordSessionEvent: vi.fn(),
        isServerWebSearchTool: () => false,
        resolveServerWebSearch: vi.fn(),
        toServerWebSearchEvent: vi.fn(),
      },
      response: {
        writeHead: vi.fn(),
        sendSse: vi.fn((event: string, data: unknown) => {
          events.push({ event, data });
          return true;
        }),
        end: ended,
        createMessageId: () => "msg_1",
      },
      onAssistantText: vi.fn(),
      ...overrides,
    },
    ended,
  };
}

describe("runClaudeStreamKickoffPipeline", () => {
  it("emits a synthetic Claude SSE response for a non-stream provider result", async () => {
    const { input, events, ended } = createInput();

    const result = await runClaudeStreamKickoffPipeline(input);

    expect(input.response.writeHead).toHaveBeenCalledWith(200, { "content-type": "text/event-stream" });
    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(input.onAssistantText).toHaveBeenCalledWith("done");
    expect(ended).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      usage,
      stopReason: "end_turn",
      externalToolCalls: [],
      requestForensicsDone: { summary: "same-prefix" },
    });
  });

  it("emits external tool calls and returns tool_use stop reason", async () => {
    const { input, events } = createInput({
      providerInput: {
        ...createInput().input.providerInput,
        generateText: vi.fn(async () => ({
          text: "",
          usage: {},
          toolCalls: [{ toolCallId: "tool_1", toolName: "Edit", input: { file_path: "a.ts" } }],
        })),
      } as never,
    });

    const result = await runClaudeStreamKickoffPipeline(input);

    expect(result.stopReason).toBe("tool_use");
    expect(result.externalToolCalls).toEqual([
      { toolCallId: "tool_1", toolName: "Edit", input: { file_path: "a.ts" } },
    ]);
    expect(events).toContainEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.ts\"}" },
      },
    });
  });

  it("replays server web search results before the final answer", async () => {
    const { input, events } = createInput({
      providerInput: {
        ...createInput().input.providerInput,
        nativeWebSearchRequested: true,
        generateText: vi
          .fn()
          .mockResolvedValueOnce({
            text: "searching",
            usage: {},
            toolCalls: [{ toolCallId: "srv_1", toolName: "web_search", input: { query: "docs" } }],
          })
          .mockResolvedValueOnce({
            text: "answer",
            usage: {},
            toolCalls: [],
          }),
        isServerWebSearchTool: (toolName: string) => toolName === "web_search",
        resolveServerWebSearch: vi.fn(async () => ({ results: [] })),
        toServerWebSearchEvent: vi.fn(() => ({
          toolUseId: "srv_1",
          toolName: "web_search",
          input: { query: "docs" },
          query: "docs",
          results: [{ type: "web_search_result", url: "https://example.com", title: "Docs", snippet: "Result" }],
        })),
      } as never,
    });

    const result = await runClaudeStreamKickoffPipeline(input);

    expect(result.stopReason).toBe("end_turn");
    expect(input.providerInput.resolveServerWebSearch).toHaveBeenCalledWith({ query: "docs" });
    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "content_block_start",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});
