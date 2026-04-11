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
    expect(out.suggestedNextStep).toContain("narrow verification");
  });

  it("does not pause repeated broad tests when verification is already green", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "ok pkg/a (cached)"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "ok pkg/a (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toContain("verification_already_green");
    expect(out.suggestedNextStep).toContain("Stop re-running broad go vet/go test checks");
  });

  it("keeps verification_already_green when non-tool narration mentions invalid parameters", () => {
    const messages = [
      { role: "assistant", content: "Invalid tool parameters encountered earlier; continuing." },
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "ok pkg/a (cached)"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "ok pkg/a (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toContain("verification_already_green");
  });

  it("pauses sustained broad green verification loops even with command variation", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go build ./... && echo Build successful" }),
      toolResult("1", "Build successful"),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok pkg/a (cached)"),
      assistantCall("3", "bash", { command: "go build ./..." }),
      toolResult("3", "Build successful"),
      assistantCall("4", "bash", { command: "go test ./... && echo done" }),
      toolResult("4", "ok pkg/a (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_green_repeat_block");
    expect(out.matchedRules).toContain("verification_already_green");
    expect(out.matchedRules).toContain("verification_green_repeat_block");
  });

  it("safety_strict profile gives more room before pausing broad green loops", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go build ./... && echo Build successful" }),
      toolResult("1", "Build successful"),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok pkg/a (cached)"),
      assistantCall("3", "bash", { command: "go build ./..." }),
      toolResult("3", "Build successful"),
      assistantCall("4", "bash", { command: "go test ./... && echo done" }),
      toolResult("4", "ok pkg/a (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages, "safety_strict");
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toContain("verification_already_green");
    expect(out.matchedRules).not.toContain("verification_green_repeat_block");
  });

  it("strict_control profile pauses earlier for repeated verification", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "FAIL pkg/a"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "FAIL pkg/a"),
    ];
    const out = evaluateExecutionGovernor(messages, "strict_control");
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("edit_before_retest");
  });

  it("pauses same failing verification signature until edit occurs", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("1", "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
      assistantCall("2", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("2", "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
      assistantCall("3", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("3", "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_fail_repeat_block");
    expect(out.matchedRules).toContain("verification_fail_repeat_block");
    expect(out.telemetry.noEditEvidence).toBe(true);
  });

  it("does not treat file paths in error output as edit evidence", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("1", "cmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
      assistantCall("2", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("2", "cmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
      assistantCall("3", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("3", "cmd/synesis/doctor_test.go:53:53: expected statement, found ')'"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.noEditEvidence).toBe(true);
    expect(out.matchedRules).toContain("verification_fail_repeat_block");
  });

  it("does not re-pause on stale loop history after a new user turn", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go build ./... && echo Build successful" }),
      toolResult("1", "Build successful"),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok pkg/a (cached)"),
      assistantCall("3", "bash", { command: "go build ./..." }),
      toolResult("3", "Build successful"),
      assistantCall("4", "bash", { command: "go test ./... && echo done" }),
      toolResult("4", "ok pkg/a (cached)"),
      { role: "user", content: "please resume plan and complete tests" },
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toEqual(["allow"]);
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
      assistantCall("2", "read", { filePath: "README.md" }),
      toolResult("2", "# README"),
      assistantCall("3", "Glob", { glob_pattern: "*" }),
      toolResult("3", "200 files"),
      assistantCall("4", "read", { filePath: "go.mod" }),
      toolResult("4", "module foo"),
      assistantCall("5", "Glob", { glob_pattern: "*" }),
      toolResult("5", "200 files"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.telemetry.totalBroadDiscoveryCalls).toBe(3);
  });

  it("ages out old broad discovery calls outside the sliding window", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "read", { filePath: "README.md" }),
      toolResult("2", "# README"),
      assistantCall("3", "Glob", { glob_pattern: "*" }),
      toolResult("3", "200 files"),
      assistantCall("4", "read", { filePath: "go.mod" }),
      toolResult("4", "module foo"),
      assistantCall("5", "Glob", { glob_pattern: "*" }),
      toolResult("5", "200 files"),
    ];
    for (let i = 6; i <= 28; i++) {
      messages.push(assistantCall(String(i), "Bash", { command: `go test ./pkg${i}` }));
      messages.push(toolResult(String(i), "ok"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.telemetry.totalBroadDiscoveryCalls).toBe(0);
  });

  it("fires broad_discovery_repeat on 4 total non-consecutive broad calls (sliding window)", () => {
    const messages = [
      assistantCall("1", "Glob", { glob_pattern: "*" }),
      toolResult("1", "200 files"),
      assistantCall("2", "read", { filePath: "README.md" }),
      toolResult("2", "# README"),
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
    expect(out.telemetry.totalBroadDiscoveryCalls).toBe(4);
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
      assistantCall("5", "Glob", { glob_pattern: "" }),
      toolResult("5", "blocked"),
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
      assistantCall("5", "read_file", { path: "a.go" }),
      toolResult("5", "ok"),
      assistantCall("6", "read_file", { path: "a.go" }),
      toolResult("6", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("bounded_exploration_budget");
    expect(out.suggestedNextStep).toContain("at most 3 files");
  });

  it("does not trigger bounded_exploration_budget for reads outside sliding window", () => {
    const padMessages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      padMessages.push(
        assistantCall(`old${i}`, "read_file", { path: "a.go" }),
        toolResult(`old${i}`, "ok"),
      );
    }
    for (let i = 0; i < 18; i++) {
      padMessages.push(
        assistantCall(`edit${i}`, "str_replace", { filePath: `f${i}.go`, oldString: "x", newString: "y" }),
        toolResult(`edit${i}`, "ok"),
      );
    }
    padMessages.push(
      assistantCall("recent1", "read_file", { path: "c.go" }),
      toolResult("recent1", "ok"),
      assistantCall("recent2", "read_file", { path: "c.go" }),
      toolResult("recent2", "ok"),
    );
    const out = evaluateExecutionGovernor(padMessages);
    expect(out.matchedRules).not.toContain("bounded_exploration_budget");
  });

  it("keeps cleanup_todo_harvest advisory when it is the only matched rule", () => {
    const messages = [
      { role: "user", content: "refactor and clean up this package" },
      assistantCall("1", "str_replace", { filePath: "pkg/a.go", oldString: "x", newString: "y" }),
      toolResult("1", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toContain("cleanup_todo_harvest");
  });

  it("does not trigger cleanup gate from generic 'harden' wording", () => {
    const messages = [
      { role: "user", content: "please harden this flow and continue implementing the feature" },
      assistantCall("1", "str_replace", { filePath: "pkg/a.go", oldString: "x", newString: "y" }),
      toolResult("1", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("cleanup_todo_harvest");
  });

  it("respects explicit user opt-out for TODO/FIXME harvest", () => {
    const messages = [
      { role: "user", content: "implement output post-processing, do not run TODO/FIXME harvest" },
      assistantCall("1", "str_replace", { filePath: "pkg/a.go", oldString: "x", newString: "y" }),
      toolResult("1", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("cleanup_todo_harvest");
  });
});
