import { describe, expect, it } from "vitest";
import { classifyLatestToolProgress } from "../src/governance/recovery-progress.js";

describe("classifyLatestToolProgress", () => {
  it("flags successful write-capable tool results as progress", () => {
    const signal = classifyLatestToolProgress([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "w1",
            function: { name: "Write", arguments: "{\"path\":\"foo.go\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "w1", content: "Added 12 lines to foo.go" },
    ]);

    expect(signal.hasRecentWriteSuccess).toBe(true);
    expect(signal.hasRecentEditContextMiss).toBe(false);
    expect(signal.toolName).toBe("Write");
  });

  it("flags edit context misses without reporting success", () => {
    const signal = classifyLatestToolProgress([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "e1",
            function: { name: "Edit", arguments: "{\"file_path\":\"ask.go\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "e1", content: "Error: String to replace not found in file." },
    ]);

    expect(signal.hasRecentWriteSuccess).toBe(false);
    expect(signal.hasRecentEditContextMiss).toBe(true);
    expect(signal.toolName).toBe("Edit");
  });

  it("ignores non-write tools even when they succeed", () => {
    const signal = classifyLatestToolProgress([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "r1",
            function: { name: "Read", arguments: "{\"file_path\":\"ask.go\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "r1", content: "package main" },
    ]);

    expect(signal.hasRecentWriteSuccess).toBe(false);
    expect(signal.hasRecentEditContextMiss).toBe(false);
    expect(signal.toolName).toBe("Read");
  });
});
