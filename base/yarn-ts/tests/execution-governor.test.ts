import { describe, expect, it } from "vitest";
import { evaluateExecutionGovernor, executionGovernorRecoveryRewriteBlock } from "../src/governance/execution-governor.js";

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

  it("formats recovery rewrite block for exploration loops", () => {
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
    const block = executionGovernorRecoveryRewriteBlock(out);
    expect(block).toContain("<SYNESIS_EXECUTION_RECOVERY");
    expect(block).toContain("Do not call Glob(\"*\")");
    expect(block).toContain("next_action=");
  });

  it("allows initial broad discovery before loop threshold", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "Glob", { glob_pattern: "*" }),
      toolResult("2", "200 files"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.telemetry.totalBroadDiscoveryCalls).toBe(2);
  });

  it("fires broad_discovery_repeat on 3 total non-consecutive broad calls", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "read", { filePath: "README.md" }),
      toolResult("2", "# README"),
      assistantCall("3", "Glob", { glob_pattern: "*" }),
      toolResult("3", "200 files"),
      assistantCall("4", "Glob", { glob_pattern: "*" }),
      toolResult("4", "200 files"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_discovery_repeat");
    expect(out.telemetry.totalBroadDiscoveryCalls).toBe(3);
  });

  it("fires broad_discovery_repeat for empty glob patterns", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "" }),
      toolResult("1", "blocked"),
      assistantCall("2", "read", { filePath: "README.md" }),
      toolResult("2", "# README"),
      assistantCall("3", "Glob", { glob_pattern: "" }),
      toolResult("3", "blocked"),
      assistantCall("4", "Glob", { glob_pattern: "" }),
      toolResult("4", "blocked"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_discovery_repeat");
  });

  it("pauses js test flow without test-entry discovery when user asks for tests", () => {
    const messages = [
      { role: "user", content: "add a comprehensive test suite for retry behavior in this typescript cli" },
      assistantCall("1", "bash", { command: "npm test" }),
      toolResult("1", "FAIL src/retry.test.ts"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("test_entry_contract");
  });

  it("does not apply test-entry-contract gate to go test workflows", () => {
    const messages = [
      { role: "user", content: "add a comprehensive test suite for retry behavior in this go cli" },
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "FAIL pkg/config"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("test_entry_contract");
  });

  it.each([
    ["rust", "add a comprehensive test suite for this rust crate", "cargo test"],
    ["java", "add a comprehensive test suite for this java module", "mvn test"],
    ["kotlin", "add a comprehensive test suite for this kotlin service", "gradle test"],
    ["csharp", "add a comprehensive test suite for this c# app", "dotnet test"],
    ["cpp", "add a comprehensive test suite for this c++ project", "ctest"],
    ["ruby", "add a comprehensive test suite for this ruby gem", "rspec"],
    ["php", "add a comprehensive test suite for this php library", "phpunit"],
    ["swift", "add a comprehensive test suite for this swift package", "swift test"],
  ])("does not force js/python config discovery for %s workflows", (_label, prompt, testCmd) => {
    const messages = [
      { role: "user", content: prompt },
      assistantCall("1", "bash", { command: testCmd }),
      toolResult("1", "FAIL some_test"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("test_entry_contract");
  });

  it("still enforces test-entry-contract for javascript workflows", () => {
    const messages = [
      { role: "user", content: "add a comprehensive test suite for retry behavior" },
      assistantCall("1", "bash", { command: "npm test" }),
      toolResult("1", "FAIL src/retry.test.ts"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("test_entry_contract");
  });

  it("still enforces test-entry-contract for python workflows", () => {
    const messages = [
      { role: "user", content: "add a comprehensive test suite for retry behavior" },
      assistantCall("1", "bash", { command: "pytest" }),
      toolResult("1", "FAIL tests/test_retry.py"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("test_entry_contract");
  });

  it("uses bounded exploration guidance with explicit read cap", () => {
    const messages = [
      assistantCall("1", "read_file", { path: "a.go" }),
      toolResult("1", "ok"),
      assistantCall("2", "read_file", { path: "a.go" }),
      toolResult("2", "ok"),
      assistantCall("3", "read_file", { path: "a.go" }),
      toolResult("3", "ok"),
      assistantCall("4", "read_file", { path: "a.go" }),
      toolResult("4", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("bounded_exploration_budget");
    expect(out.suggestedNextStep).toContain("at most 3 files");
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
