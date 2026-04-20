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

  it("treats apply_patch alias as write-capable progress", () => {
    const signal = classifyLatestToolProgress([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "w2",
            function: { name: "apply_patch", arguments: "{\"path\":\"foo.go\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "w2", content: "Applied patch successfully to foo.go" },
    ]);

    expect(signal.hasRecentWriteSuccess).toBe(true);
    expect(signal.hasRecentEditContextMiss).toBe(false);
    expect(signal.toolName).toBe("apply_patch");
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

  it("does not classify non-write tool failures as edit-context misses", () => {
    const signal = classifyLatestToolProgress([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "b1",
            function: { name: "Bash", arguments: "{\"command\":\"go test ./pkg/jq -v\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "b1", content: "jq_test.go:11: Error: String to replace not found in file." },
    ]);

    expect(signal.hasRecentWriteSuccess).toBe(false);
    expect(signal.hasRecentEditContextMiss).toBe(false);
    expect(signal.hasRecentFailure).toBe(true);
    expect(signal.toolName).toBe("Bash");
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
