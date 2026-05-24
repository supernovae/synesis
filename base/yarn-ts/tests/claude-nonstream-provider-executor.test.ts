import { describe, expect, it, vi } from "vitest";
import {
  createClaudeNonStreamProviderExecutorInput,
  executeClaudeNonStreamProviderLoop,
} from "../src/streaming/claude-nonstream-provider-executor.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

describe("executeClaudeNonStreamProviderLoop", () => {
  it("retries and falls back when required phase tool-call validation fails", async () => {
    const recordSessionEvent = vi.fn();
    const generateText = vi.fn()
      .mockResolvedValueOnce({ text: "first", usage, toolCalls: [] })
      .mockResolvedValueOnce({ text: "repair", usage, toolCalls: [] })
      .mockResolvedValueOnce({
        text: "fallback",
        usage,
        toolCalls: [{ toolCallId: "call_1", toolName: "Read", input: { file_path: "README.md" } }],
      });
    const toolChoices: unknown[] = [];

    const result = await executeClaudeNonStreamProviderLoop({
      initialMessages: [{ role: "user", content: "read" }],
      model: "model",
      resolvedModelId: "claude-test",
      orchestrationMaxOutputTokens: 100,
      requestMaxTokens: 50,
      initialToolChoice: "required",
      phasePolicy: {
        active: true,
        toolChoice: "required",
        allowedCanonicalTools: ["Read"],
        maxToolCalls: 1,
      },
      governorPhase: "explore",
      nativeWebSearchRequested: false,
      clampMaxOutputTokens: (tokens) => tokens,
      generateText,
      readUsage: () => usage,
      captureForensics: (_messages, toolChoice) => {
        toolChoices.push(toolChoice);
        return { record: { requestId: "req" }, serialized: "{}" };
      },
      finalizeForensics: () => ({ requestId: "req" }) as never,
      recordSessionEvent,
      isServerWebSearchTool: () => false,
      resolveServerWebSearch: vi.fn(),
      toServerWebSearchEvent: vi.fn(),
    });

    expect(generateText).toHaveBeenCalledTimes(3);
    expect(toolChoices).toEqual(["required", "required", "auto"]);
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "phase_required_validation_retry",
      component: "execution-governor",
      detail: "reasons=missing_tool_call",
    });
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "phase_required_validation_fallback",
      component: "execution-governor",
      detail: "fallback_after_retry reasons=missing_tool_call",
    });
    expect(result.result.text).toBe("fallback");
    expect(result.serverWebSearchEvents).toEqual([]);
  });

  it("replays native server web search results and continues the provider loop", async () => {
    const generateText = vi.fn()
      .mockResolvedValueOnce({
        text: "searching",
        usage,
        toolCalls: [{ toolCallId: "srv_1", toolName: "web_search", input: { query: "cache" } }],
      })
      .mockResolvedValueOnce({ text: "done", usage, toolCalls: [] });
    const resolveServerWebSearch = vi.fn(async () => ({
      query: "cache",
      results: [{ url: "https://example.com", title: "Example", snippet: "Result" }],
    }));

    const result = await executeClaudeNonStreamProviderLoop({
      initialMessages: [{ role: "user", content: "search" }],
      model: "model",
      resolvedModelId: "claude-test",
      orchestrationMaxOutputTokens: 100,
      samplingOptions: { temperature: 0 },
      initialToolChoice: "auto",
      phasePolicy: { active: false },
      governorPhase: "explore",
      nativeWebSearchRequested: true,
      clampMaxOutputTokens: (tokens) => tokens,
      generateText,
      readUsage: () => usage,
      captureForensics: () => null,
      finalizeForensics: () => undefined,
      recordSessionEvent: vi.fn(),
      isServerWebSearchTool: (toolName) => toolName === "web_search",
      resolveServerWebSearch,
      toServerWebSearchEvent: (toolCallId, toolName, input, response) => ({
        toolUseId: `srvtoolu_${toolCallId}`,
        toolName,
        input,
        query: String(response.query ?? input.query ?? ""),
        results: [{ type: "web_search_result", url: "https://example.com", title: "Example", snippet: "Result" }],
      }),
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(resolveServerWebSearch).toHaveBeenCalledWith({ query: "cache" });
    expect(generateText.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "searching" },
            { type: "tool-call", toolCallId: "srv_1", toolName: "web_search", input: { query: "cache" } },
          ],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: "srv_1",
            toolName: "web_search",
            output: {
              type: "text",
              value: JSON.stringify({
                query: "cache",
                results: [{ url: "https://example.com", title: "Example", snippet: "Result" }],
              }),
            },
          }],
        },
      ],
    }));
    expect(result.result.text).toBe("done");
    expect(result.serverWebSearchEvents).toEqual([expect.objectContaining({
      toolUseId: "srvtoolu_srv_1",
      query: "cache",
    })]);
  });
});

describe("createClaudeNonStreamProviderExecutorInput", () => {
  it("binds route scope into forensics, events, and server web search", async () => {
    const recordEvent = vi.fn();
    const capture = vi.fn(() => ({ record: { requestId: "req_scope" }, serialized: "{}" }));
    const finalize = vi.fn(() => ({ requestId: "req_scope" }));
    const resolve = vi.fn(async () => ({ query: "cache", results: [] }));

    const input = createClaudeNonStreamProviderExecutorInput({
      initialMessages: [{ role: "user", content: "hello" }],
      model: "model",
      resolvedModelId: "claude-resolved",
      orchestrationMaxOutputTokens: 100,
      providerOptions: { anthropic: { cacheControl: true } },
      phasePolicy: { active: false },
      governorPhase: "explore",
      nativeWebSearchRequested: true,
      clampMaxOutputTokens: (tokens) => tokens,
      generateText: vi.fn(),
      readUsage: () => usage,
      scope: {
        sessionKey: "session_scope",
        requestId: "req_scope",
        recordEvent,
      },
      forensics: {
        path: "/v1/messages",
        stream: false,
        tools: [{ name: "Read" }],
        capture,
        finalize,
      },
      isServerWebSearchTool: (toolName) => toolName === "web_search",
      serverWebSearch: {
        conversationId: "conversation_1",
        sourceSurface: "yarn_chat",
        toolName: "web_search",
        resolve,
      },
      toServerWebSearchEvent: vi.fn(),
    });

    const forensics = input.captureForensics([{ role: "user", content: "hello" }], "auto");
    const finalized = input.finalizeForensics(forensics, usage);
    input.recordSessionEvent({ eventKind: "event", component: "component", detail: "detail" });
    await input.resolveServerWebSearch({ query: "cache" });

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_scope",
      requestId: "req_scope",
      path: "/v1/messages",
      resolvedModelId: "claude-resolved",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "Read" }],
      toolChoice: "auto",
      providerOptions: { anthropic: { cacheControl: true } },
    }));
    expect(finalize).toHaveBeenCalledWith(forensics, usage, {
      sessionKey: "session_scope",
      requestId: "req_scope",
      resolvedModelId: "claude-resolved",
    });
    expect(finalized).toEqual({ requestId: "req_scope" });
    expect(recordEvent).toHaveBeenCalledWith({ eventKind: "event", component: "component", detail: "detail" });
    expect(resolve).toHaveBeenCalledWith({ query: "cache" }, {
      requestId: "req_scope",
      sessionKey: "session_scope",
      conversationId: "conversation_1",
      traceId: "req_scope",
      sourceSurface: "yarn_chat",
      toolName: "web_search",
    });
  });
});
