import { describe, expect, it } from "vitest";
import { buildClaudeNonStreamResponseContent } from "../src/streaming/claude-nonstream-response.js";

describe("buildClaudeNonStreamResponseContent", () => {
  it("preserves Claude non-stream response block ordering", () => {
    const content = buildClaudeNonStreamResponseContent({
      reasoning: "thinking",
      serverWebSearchEvents: [{
        toolUseId: "srvtoolu_1",
        toolName: "web_search",
        input: { query: "cache" },
        query: "cache",
        results: [{
          type: "web_search_result",
          url: "https://example.com",
          title: "Example",
          snippet: "Result",
        }],
      }],
      finalText: "done",
      toolCalls: [{ toolCallId: "toolu_1", toolName: "Read", input: { file_path: "README.md" } }],
    });

    expect(content).toEqual([
      { type: "thinking", thinking: "thinking" },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "cache" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{
          type: "web_search_result",
          url: "https://example.com",
          title: "Example",
          snippet: "Result",
        }],
      },
      { type: "text", text: "done" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
    ]);
  });

  it("formats server web search errors and falls back to empty text", () => {
    expect(buildClaudeNonStreamResponseContent({
      serverWebSearchEvents: [{
        toolUseId: "srvtoolu_2",
        toolName: "web_search",
        input: { query: "cache" },
        query: "cache",
        results: [],
        errorCode: "upstream_error",
      }],
      finalText: "",
      toolCalls: [],
    })).toEqual([
      { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "cache" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_2",
        content: { type: "web_search_tool_result_error", error_code: "upstream_error" },
      },
    ]);

    expect(buildClaudeNonStreamResponseContent({
      serverWebSearchEvents: [],
      finalText: "",
      toolCalls: [],
    })).toEqual([{ type: "text", text: "" }]);
  });
});
