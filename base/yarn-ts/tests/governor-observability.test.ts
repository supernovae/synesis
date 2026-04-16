import { describe, expect, it } from "vitest";
import { deriveGovernorLoopObservability } from "../src/governance/governor-observability.js";

describe("deriveGovernorLoopObservability", () => {
  it("detects no tool calls after latest user", () => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      { role: "assistant" },
      { role: "assistant" },
    ]);
    expect(out.hasRunTest).toBe(false);
    expect(out.lastAssistantToolCalls).toBe(0);
    expect(out.assistantToolCallsSinceLatestUser).toBe(0);
  });

  it("counts assistant tool calls and detects test commands", () => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "bash", arguments: "{\"command\":\"go test ./cmd/synesis -run TestRunCompletion -v\"}" } },
        ],
      },
      {
        role: "assistant",
        tool_calls: [
          { id: "2", function: { name: "read_file", arguments: "{\"path\":\"cmd/synesis/completion_test.go\"}" } },
        ],
      },
    ]);
    expect(out.hasRunTest).toBe(true);
    expect(out.lastAssistantToolCalls).toBe(1);
    expect(out.assistantToolCallsSinceLatestUser).toBe(2);
  });

  it("only considers messages after most recent user turn", () => {
    const out = deriveGovernorLoopObservability([
      {
        role: "assistant",
        tool_calls: [
          { id: "0", function: { name: "bash", arguments: "{\"command\":\"go test ./...\"}" } },
        ],
      },
      { role: "user" },
      { role: "assistant" },
    ]);
    expect(out.hasRunTest).toBe(false);
    expect(out.assistantToolCallsSinceLatestUser).toBe(0);
  });
});
