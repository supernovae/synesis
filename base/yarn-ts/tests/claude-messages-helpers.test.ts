import { describe, expect, it, vi } from "vitest";
import {
  claudeSystemToMessage,
  hasClaudeNativeWebSearchTool,
  isClaudeWebSearchToolName,
  resolveClaudeConversationId,
  toClaudeServerWebSearchEvent,
} from "../src/protocol/claude-messages-helpers.js";

describe("claude messages helpers", () => {
  it("preserves Claude system text and cache control", () => {
    expect(claudeSystemToMessage([
      { type: "text", text: "first" },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ])).toEqual({
      role: "system",
      content: "first\nsecond",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("resolves Claude Code conversation ids from nested metadata", () => {
    expect(resolveClaudeConversationId({
      user_id: JSON.stringify({ device_id: "dev", session_id: "session-123" }),
    }, {})).toBe("session-123");
  });

  it("falls back to Claude session headers and logs debug misses", () => {
    expect(resolveClaudeConversationId(undefined, {
      "x-claude-session-id": "session-from-header",
    })).toBe("session-from-header");

    const debugLog = vi.fn();
    expect(resolveClaudeConversationId(undefined, {}, {
      debugProtocol: true,
      debugLog,
    })).toBe("");
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({
      knownHeaders: expect.objectContaining({ "x-request-id": undefined }),
    }), "claude_conversation_id_resolution_miss");
  });

  it("recognizes and formats Claude native web search events", () => {
    expect(hasClaudeNativeWebSearchTool([{ type: "web_search_20250305" }])).toBe(true);
    expect(isClaudeWebSearchToolName(" web_search ")).toBe(true);
    expect(toClaudeServerWebSearchEvent("call-1", "web_search", { query: "q" }, {
      results: [{ url: "https://example.test", title: "Example", snippet: "Snippet" }],
    })).toMatchObject({
      toolUseId: "srvtoolu_call-1",
      toolName: "web_search",
      query: "q",
      results: [{ type: "web_search_result", url: "https://example.test", title: "Example", snippet: "Snippet" }],
    });
  });
});
