import { describe, it, expect } from "vitest";
import { normalizeHistoricalContent, stabilizeToolCallIds } from "../src/reduction/historical-normalizer.js";

describe("normalizeHistoricalContent", () => {
  it("replaces ISO timestamps in old tool results", () => {
    const messages = [
      { role: "tool", content: "Build at 2026-04-18T15:32:01Z completed" },
      { role: "tool", content: "Test at 2026-04-18T16:00:00.123Z done" },
      { role: "user", content: "fix the bug" },
    ];
    const result = normalizeHistoricalContent(messages, 2);
    expect(result.messages[0].content).toBe("Build at [TIMESTAMP] completed");
    expect(result.messages[1].content).toBe("Test at [TIMESTAMP] done");
    expect(result.stats.timestampsReplaced).toBe(2);
  });

  it("does not touch messages in the keep window", () => {
    const messages = [
      { role: "tool", content: "Old: 2026-01-01T00:00:00Z" },
      { role: "tool", content: "Recent: 2026-04-18T15:32:01Z" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.messages[0].content).toBe("Old: [TIMESTAMP]");
    expect(result.messages[1].content).toBe("Recent: 2026-04-18T15:32:01Z");
  });

  it("replaces home directory paths with ~", () => {
    const messages = [
      { role: "tool", content: "File at /Users/alice/project/src/main.ts" },
      { role: "user", content: "look at it" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.messages[0].content).toBe("File at ~/project/src/main.ts");
    expect(result.stats.pathsNormalized).toBe(1);
  });

  it("uses specific homeDir when provided", () => {
    const messages = [
      { role: "tool", content: "Path: /home/deploy/app/index.js" },
      { role: "user", content: "ok" },
    ];
    const result = normalizeHistoricalContent(messages, 1, "/home/deploy");
    expect(result.messages[0].content).toBe("Path: ~/app/index.js");
  });

  it("collapses consecutive blank lines", () => {
    const messages = [
      { role: "tool", content: "line1\n\n\n\n\nline2" },
      { role: "user", content: "ok" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.messages[0].content).toBe("line1\n\nline2");
    expect(result.stats.blankLinesCollapsed).toBe(1);
  });

  it("skips system messages", () => {
    const messages = [
      { role: "system", content: "Instructions with 2026-04-18T00:00:00Z timestamp" },
      { role: "user", content: "hi" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.messages[0].content).toBe("Instructions with 2026-04-18T00:00:00Z timestamp");
  });

  it("skips non-string content", () => {
    const messages = [
      { role: "tool", content: [{ type: "text", text: "2026-04-18T00:00:00Z" }] as unknown },
      { role: "user", content: "ok" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.stats.messagesNormalized).toBe(0);
  });

  it("returns unchanged messages when nothing to normalize", () => {
    const messages = [
      { role: "tool", content: "clean output" },
      { role: "user", content: "ok" },
    ];
    const result = normalizeHistoricalContent(messages, 1);
    expect(result.messages[0]).toBe(messages[0]); // same reference
  });
});

describe("stabilizeToolCallIds", () => {
  it("rewrites old tool call IDs to deterministic format", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "I'll read the file",
        tool_calls: [{ id: "toolu_01ABC123", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } }],
      },
      { role: "tool", tool_call_id: "toolu_01ABC123", content: "file contents..." },
      { role: "user", content: "now edit it" },
      {
        role: "assistant",
        content: "editing",
        tool_calls: [{ id: "toolu_01XYZ789", function: { name: "edit_file", arguments: '{}' } }],
      },
      { role: "tool", tool_call_id: "toolu_01XYZ789", content: "done" },
    ];

    const result = stabilizeToolCallIds(messages, 3);
    // First assistant+tool pair (before keepFrom=3) should be rewritten
    expect(result.messages[1].tool_calls![0].id).toBe("tc_1_0");
    expect(result.messages[2].tool_call_id).toBe("tc_1_0");
    // Second pair (at index 4,5 >= keepFrom=3) should be untouched
    expect(result.messages[4].tool_calls![0].id).toBe("toolu_01XYZ789");
    expect(result.messages[5].tool_call_id).toBe("toolu_01XYZ789");
    expect(result.rewriteCount).toBe(2);
  });

  it("returns original messages when no rewrites needed", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = stabilizeToolCallIds(messages, 0);
    expect(result.messages).toBe(messages);
    expect(result.rewriteCount).toBe(0);
  });

  it("handles multiple tool calls in one assistant message", () => {
    const messages = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_aaa", function: { name: "read_file", arguments: '{}' } },
          { id: "call_bbb", function: { name: "search", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_aaa", content: "result1" },
      { role: "tool", tool_call_id: "call_bbb", content: "result2" },
      { role: "user", content: "thanks" },
    ];

    const result = stabilizeToolCallIds(messages, 4);
    expect(result.messages[1].tool_calls![0].id).toBe("tc_1_0");
    expect(result.messages[1].tool_calls![1].id).toBe("tc_1_1");
    expect(result.messages[2].tool_call_id).toBe("tc_1_0");
    expect(result.messages[3].tool_call_id).toBe("tc_1_1");
    expect(result.rewriteCount).toBe(4);
  });

  it("rewrites Claude-format tool_use blocks in assistant content arrays", () => {
    const messages = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll fix it." },
          { type: "tool_use", id: "toolu_01AAA", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01AAA", content: "file1.go\nfile2.go" },
        ],
      },
      { role: "user", content: "thanks" },
    ];

    const result = stabilizeToolCallIds(messages, 3);
    const assistantContent = result.messages[1].content as Array<Record<string, unknown>>;
    expect(assistantContent[1].id).toBe("tc_1_0");
    const userContent = result.messages[2].content as Array<Record<string, unknown>>;
    expect(userContent[0].tool_use_id).toBe("tc_1_0");
    expect(result.rewriteCount).toBe(2);
  });

  it("rewrites Claude tool_result references even past keepFromIndex", () => {
    const messages = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01BBB", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01BBB", content: "file content" },
        ],
      },
    ];

    // keepFromIndex=2 means the tool_result at index 2 is in the keep window
    // but the assistant at index 1 is before it — both need consistent IDs
    const result = stabilizeToolCallIds(messages, 2);
    const assistantContent = result.messages[1].content as Array<Record<string, unknown>>;
    expect(assistantContent[0].id).toBe("tc_1_0");
    const userContent = result.messages[2].content as Array<Record<string, unknown>>;
    expect(userContent[0].tool_use_id).toBe("tc_1_0");
  });
});
