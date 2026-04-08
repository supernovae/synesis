import { describe, expect, it } from "vitest";
import { evaluateExecutionGovernor } from "../src/governance/execution-governor.js";

function assistantCall(id: string, name: string, args: unknown) {
  return { role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: args } }] };
}
function toolResult(id: string, content: string) {
  return { role: "tool", tool_call_id: id, content };
}

describe("execution governor", () => {
  it("pauses repeated broad tests", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "FAIL pkg/a"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "FAIL pkg/a"),
      assistantCall("3", "bash", { command: "go test ./..." }),
      toolResult("3", "FAIL pkg/a"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_to_narrow_verification");
    expect(out.matchedRules).toContain("no_repeat_without_change");
    expect(out.telemetry.noEditEvidence).toBe(true);
    expect(out.suggestedNextStep).toContain("go test");
  });

  it("does not mark no-repeat-without-change when edits are present", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "FAIL pkg/a in pkg/a/file_test.go"),
      assistantCall("2", "apply_patch", { path: "pkg/a/file.go" }),
      toolResult("2", "updated pkg/a/file.go"),
      assistantCall("3", "bash", { command: "go test ./..." }),
      toolResult("3", "FAIL pkg/a in pkg/a/file_test.go"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).not.toContain("no_repeat_without_change");
    expect(out.telemetry.noEditEvidence).toBe(false);
  });

  it("allows non-repetitive flow", () => {
    const messages = [
      assistantCall("1", "read_file", { path: "a.ts" }),
      toolResult("1", "ok"),
      assistantCall("2", "apply_patch", { file: "a.ts" }),
      toolResult("2", "patched"),
      assistantCall("3", "run_test", { command: "npm test -- src/a.test.ts" }),
      toolResult("3", "PASS"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
  });

  it("pauses repeated broad discovery loop on glob star", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "Glob", { glob_pattern: "*" }),
      toolResult("2", "200 files"),
      assistantCall("3", "Glob", { glob_pattern: "*" }),
      toolResult("3", "200 files"),
      assistantCall("4", "Glob", { glob_pattern: "*" }),
      toolResult("4", "200 files"),
      assistantCall("5", "Glob", { glob_pattern: "*" }),
      toolResult("5", "200 files"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_discovery_repeat");
    expect(out.telemetry.repeatedBroadDiscoveryCalls).toBeGreaterThanOrEqual(4);
    expect(out.suggestedNextStep).toContain("synesis_inspect_repo");
  });

  it("allows initial broad discovery before loop threshold", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "Glob", { glob_pattern: "*" }),
      toolResult("2", "200 files"),
      assistantCall("3", "Glob", { glob_pattern: "*" }),
      toolResult("3", "200 files"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.telemetry.repeatedBroadDiscoveryCalls).toBe(2);
  });

  it("pauses test flow without test-entry discovery when user asks for tests", () => {
    const messages = [
      { role: "user", content: "add a comprehensive test suite for retry behavior" },
      assistantCall("1", "run_test", { preset: "go" }),
      toolResult("1", "FAIL pkg/a"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("test_entry_contract");
  });

  it("pauses cleanup flow if TODO harvest is skipped before edits", () => {
    const messages = [
      { role: "user", content: "refactor and clean up this package" },
      assistantCall("1", "str_replace", { filePath: "pkg/a.go", oldString: "x", newString: "y" }),
      toolResult("1", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("cleanup_todo_harvest");
  });
});
