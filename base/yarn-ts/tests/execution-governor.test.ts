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

  it("does not hard-pause retest rules after pivoting to non-verification action", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./..." }),
      toolResult("1", "FAIL pkg/a"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "FAIL pkg/a"),
      assistantCall("3", "read_file", { path: "cmd/synesis/plan.md" }),
      toolResult("3", "phase checklist"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.reason).toBe("verification_loop_advisory_after_pivot");
    expect(out.matchedRules).toContain("no_repeat_without_change");
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

  it("treats zero-failure summaries as green verification", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test ./... 2>&1" }),
      toolResult("1", "ok pkg/a (cached)\nPASS\n0 failed"),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok pkg/a (cached)\nPASS\n0 failed"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.reason).toBe("verification_already_green");
    expect(out.matchedRules).toContain("verification_already_green");
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
    expect(out.matchedRules).not.toContain("edit_before_retest");
    expect(out.matchedRules).not.toContain("no_repeat_without_change");
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
    expect(out.reason).toBe("verification_same_failure_signature_replay");
    expect(out.matchedRules).toContain("verification_same_failure_signature_replay");
    expect(out.telemetry.noEditEvidence).toBe(true);
  });

  it("pauses repeated compile-signature replay with focused fix guidance", () => {
    const messages = [
      assistantCall("1", "bash", { command: "npm test" }),
      toolResult("1", "src/cli.ts:42:5 - error TS6133: 'clipboard' is declared but its value is never read."),
      assistantCall("2", "bash", { command: "npm test" }),
      toolResult("2", "src/cli.ts:42:5 - error TS6133: 'clipboard' is declared but its value is never read."),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_same_failure_signature_replay");
    expect(out.matchedRules).toContain("verification_same_failure_signature_replay");
    expect(out.suggestedNextStep).toContain("one concrete code fix");
  });

  it("pauses repeated edit-failure replay even when reads are interleaved", () => {
    const messages = [
      assistantCall("1", "edit", { file_path: "cmd/synesis/main.go", old_string: "import (", new_string: "import (\n\t\"x\"" }),
      toolResult("1", "Error editing file: old_string not found"),
      assistantCall("2", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("2", "package main\nimport (\n\t\"fmt\"\n)"),
      assistantCall("3", "edit", { file_path: "cmd/synesis/main.go", old_string: "import (", new_string: "import (\n\t\"x\"" }),
      toolResult("3", "Error editing file: old_string not found"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("edit_failure_replay");
    expect(out.matchedRules).toContain("edit_failure_replay");
    expect(out.suggestedNextStep).toContain("already contain the changes");
  });

  it("pauses duplicate task creation replay", () => {
    const messages = [
      assistantCall("1", "TaskCreate", { title: "Implement Clipboard Support" }),
      toolResult("1", "task created"),
      assistantCall("2", "TaskCreate", { title: "Implement Clipboard Support" }),
      toolResult("2", "task created"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("task_creation_replay");
    expect(out.matchedRules).toContain("task_creation_replay");
  });

  it("pauses read/search churn after declaration-only edit until follow-through edit", () => {
    const messages = [
      assistantCall("1", "edit", { file_path: "cmd/synesis/ask.go", old_string: "import (", new_string: "import (\n\t\"synesis.sh/synesis/pkg/clipboard\"" }),
      toolResult("1", "Added 1 line\nimport clipboard"),
      assistantCall("2", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("2", "file content"),
      assistantCall("3", "grep", { pattern: "from-clipboard" }),
      toolResult("3", "match"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("declaration_followthrough_required");
    expect(out.matchedRules).toContain("declaration_followthrough_required");
  });

  it("pauses completion claims when tasks are not marked done", () => {
    const messages = [
      { role: "assistant", content: "I've completed the clipboard support implementation." },
      assistantCall("1", "TaskCreate", { title: "Implement Clipboard Support" }),
      toolResult("1", "task created"),
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("completion_claim_requires_task_update");
    expect(out.matchedRules).toContain("completion_claim_requires_task_update");
  });

  it("does not pause completion claims when TodoWrite marks tasks done", () => {
    const messages = [
      { role: "assistant", content: "I've completed the clipboard support implementation." },
      assistantCall("1", "TodoWrite", {
        merge: true,
        todos: [
          { id: "clipboard", content: "Implement Clipboard Support", status: "done" },
        ],
      }),
      toolResult("1", "updated 1 todo"),
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
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

  it("pauses repeated successful narrow verification and asks for completion report", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -c ./cmd/synesis 2>&1 && echo Build OK" }),
      toolResult("1", "Build OK"),
      assistantCall("2", "bash", { command: "go test -c ./cmd/synesis 2>&1 && echo Build OK" }),
      toolResult("2", "Build OK"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.reason).toBe("verification_done_report");
    expect(out.matchedRules).toContain("verification_done_report");
  });

  it("pauses repeated no-signal narrow verification and asks to conclude", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test -c ./cmd/synesis 2>&1" }),
      toolResult("2", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.reason).toBe("verification_no_signal_repeat");
    expect(out.matchedRules).toContain("verification_no_signal_repeat");
  });

  it("pauses repeated truncated verification output and asks for non-truncated check", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -v ./cmd/synesis -run \"Test.*\" 2>&1 | head -50" }),
      toolResult("1", "=== RUN   TestSignalHandling_ContextCancellation"),
      assistantCall("2", "bash", { command: "go test -v ./cmd/synesis -run \"Test.*\" 2>&1 | head -100" }),
      toolResult("2", "=== RUN   TestSignalHandling_ContextCancellation"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_truncated_output");
    expect(out.matchedRules).toContain("verification_truncated_output");
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
      assistantCall("4", "str_replace", { filePath: "go.mod", oldString: "a", newString: "b" }),
      toolResult("4", "ok"),
      assistantCall("5", "Glob", { glob_pattern: "*" }),
      toolResult("5", "200 files"),
    ];
    // Add enough events after the edit to push the globs outside the sliding window
    for (let i = 6; i <= 28; i++) {
      messages.push(assistantCall(String(i), "str_replace", { filePath: `pkg${i}/main.go`, oldString: "old", newString: "new" }));
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
    expect(out.matchedRules).toContain("exploration_stall_no_edit");
    expect(out.suggestedNextStep).toContain("search/read/list commands");
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

  it("pauses on alternating verification commands without edits (verification_stall_no_edit)", () => {
    const messages = [
      { role: "user", content: "implement bundle files for the synesis CLI" },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("2", "ok  synesis.sh/synesis/cmd/synesis  (cached)\nok  synesis.sh/synesis/internal/api (cached)"),
      assistantCall("3", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("4", "ok  synesis.sh/synesis/cmd/synesis  (cached)\nok  synesis.sh/synesis/internal/api (cached)"),
      assistantCall("5", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("6", "ok  synesis.sh/synesis/cmd/synesis  (cached)\nok  synesis.sh/synesis/internal/api (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_stall_no_edit");
    expect(out.telemetry.trailingVerificationRunLength).toBe(6);
    expect(out.reason).toBe("verification_stall_no_edit");
    expect(out.suggestedNextStep).toContain("Stop running build/test/read commands");
  });

  it("does not fire verification_stall_no_edit when edits are interspersed", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("2", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
      assistantCall("3", "str_replace", { filePath: "pkg/bundle/bundle.go", oldString: "x", newString: "y" }),
      toolResult("3", "ok"),
      assistantCall("4", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("4", ""),
      assistantCall("5", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("5", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_stall_no_edit");
    expect(out.telemetry.trailingVerificationRunLength).toBe(2);
  });

  it("does not fire verification_stall_no_edit when there are failures", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("2", "FAIL synesis.sh/synesis/pkg/bundle [build failed]"),
      assistantCall("3", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("4", "FAIL synesis.sh/synesis/pkg/bundle [build failed]"),
      assistantCall("5", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("6", "FAIL synesis.sh/synesis/pkg/bundle [build failed]"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_stall_no_edit");
  });

  it("fires recovery rewrite block for verification_stall_no_edit", () => {
    const decision = evaluateExecutionGovernor([
      { role: "user", content: "implement feature" },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "go test ./... 2>&1" }),
      toolResult("4", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
      assistantCall("5", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "go test ./... 2>&1" }),
      toolResult("6", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
    ]);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP running build, test, and read");
    expect(block).toContain("verification_stall_no_edit");
    expect(block).toContain("SYNESIS_EXECUTION_RECOVERY");
  });

  it("counts redundant re-reads toward verification stall when mixed with tests", () => {
    const messages = [
      { role: "user", content: "validate clipboard and update plan" },
      assistantCall("1", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("1", "PASS\nok  synesis.sh/synesis/pkg/clipboard"),
      assistantCall("2", "read_file", { file_path: "/src/pkg/clipboard/clipboard.go" }),
      toolResult("2", "package clipboard\n\nimport \"os/exec\"\n\nfunc Copy(text string) { exec.Command(\"pbcopy\") }"),
      assistantCall("3", "read_file", { file_path: "/src/pkg/clipboard/clipboard_test.go" }),
      toolResult("3", "package clipboard\n\nimport \"testing\"\n\nfunc TestCopyAndPaste(t *testing.T) { t.Log(\"ok\") }"),
      assistantCall("4", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("4", "PASS\nok  synesis.sh/synesis/pkg/clipboard  (cached)"),
      assistantCall("5", "read_file", { file_path: "/src/pkg/clipboard/clipboard.go" }),
      toolResult("5", "package clipboard\n\nimport \"os/exec\"\n\nfunc Copy(text string) { exec.Command(\"pbcopy\") }"),
      assistantCall("6", "read_file", { file_path: "/src/pkg/clipboard/clipboard_test.go" }),
      toolResult("6", "package clipboard\n\nimport \"testing\"\n\nfunc TestCopyAndPaste(t *testing.T) { t.Log(\"ok\") }"),
      assistantCall("7", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("7", "PASS\nok  synesis.sh/synesis/pkg/clipboard  (cached)"),
      assistantCall("8", "read_file", { file_path: "/src/pkg/clipboard/clipboard.go" }),
      toolResult("8", "package clipboard\n\nimport \"os/exec\"\n\nfunc Copy(text string) { exec.Command(\"pbcopy\") }"),
      assistantCall("9", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("9", "PASS\nok  synesis.sh/synesis/pkg/clipboard  (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // no_progress_loop fires first (9 interleaved non-edit commands) which is the correct
    // higher-priority signal; verification_stall also matches but no_progress takes precedence.
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("no_progress_loop");
    expect(out.suggestedNextStep).toContain("single code edit");
  });

  it("does not count first reads toward verification stall (only re-reads)", () => {
    const messages = [
      { role: "user", content: "validate clipboard" },
      assistantCall("1", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("1", "PASS\nok  synesis.sh/synesis/pkg/clipboard"),
      assistantCall("2", "read_file", { file_path: "/src/pkg/clipboard/clipboard.go" }),
      toolResult("2", "package clipboard\n\nimport \"os/exec\"\n\nfunc Copy(text string) { exec.Command(\"pbcopy\") }"),
      assistantCall("3", "read_file", { file_path: "/src/pkg/clipboard/clipboard_test.go" }),
      toolResult("3", "package clipboard\n\nimport \"testing\"\n\nfunc TestCopyAndPaste(t *testing.T) { t.Log(\"ok\") }"),
      assistantCall("4", "read_file", { file_path: "/src/cmd/synesis/ask.go" }),
      toolResult("4", "package main\n\nfunc ask() { flag.Parse() }"),
      assistantCall("5", "bash", { command: "go test -v ./pkg/clipboard/..." }),
      toolResult("5", "PASS\nok  synesis.sh/synesis/pkg/clipboard  (cached)"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_stall_no_edit");
  });

  it("uses strict_control threshold for verification stall", () => {
    const messages = [
      { role: "user", content: "implement feature" },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "go test ./... 2>&1" }),
      toolResult("4", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
    ];
    const strict = evaluateExecutionGovernor(messages, "strict_control");
    expect(strict.pause).toBe(true);
    expect(strict.matchedRules).toContain("verification_stall_no_edit");
    const balanced = evaluateExecutionGovernor(messages, "balanced_completion");
    expect(balanced.matchedRules).not.toContain("verification_stall_no_edit");
  });

  it("pauses on repeated 'no test files' results (no_test_files_repeat)", () => {
    const messages = [
      { role: "user", content: "validate bundle and make sure there are tests" },
      assistantCall("1", "bash", { command: "go test -v ./pkg/bundle/..." }),
      toolResult("1", "?  synesis.sh/synesis/pkg/bundle  [no test files]"),
      assistantCall("2", "bash", { command: "go test -v ./pkg/bundle/..." }),
      toolResult("2", "?  synesis.sh/synesis/pkg/bundle  [no test files]"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("no_test_files_repeat");
    expect(out.reason).toBe("no_test_files_repeat");
    expect(out.suggestedNextStep).toContain("create a test file");
  });

  it("fires recovery rewrite block for no_test_files_repeat", () => {
    const decision = evaluateExecutionGovernor([
      { role: "user", content: "validate bundle" },
      assistantCall("1", "bash", { command: "go test -v ./pkg/bundle/..." }),
      toolResult("1", "?  synesis.sh/synesis/pkg/bundle  [no test files]"),
      assistantCall("2", "bash", { command: "go test -v ./pkg/bundle/..." }),
      toolResult("2", "?  synesis.sh/synesis/pkg/bundle  [no test files]"),
    ]);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP running the test command");
    expect(block).toContain("CREATE a test file");
    expect(block).toContain("no_test_files_repeat");
  });

  it("fires verbal_intent_without_action on repeated 'I'll' declarations without edits", () => {
    const messages = [
      { role: "user", content: "implement bundle files for the synesis CLI" },
      { role: "assistant", content: "I'll implement bundle files for the synesis CLI. Let me first check the current state." },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go test ./... 2>&1 | tail -15" }),
      toolResult("2", "ok  synesis.sh/synesis/cmd/synesis  (cached)"),
      { role: "assistant", content: "I'll implement bundle files. Let me check the current state and verify the implementation." },
      assistantCall("3", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
      { role: "assistant", content: "I'll clean up the duplicate tasks and finish the bundle files implementation." },
      assistantCall("4", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("4", "Build successful"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verbal_intent_without_action");
    expect(out.reason).toBe("verbal_intent_without_action");
    expect(out.suggestedNextStep).toContain("Stop narrating intent");
  });

  it("does not fire verbal_intent_without_action when edits are made", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      { role: "assistant", content: "I'll implement bundle files." },
      assistantCall("1", "str_replace", { filePath: "pkg/bundle/bundle.go", oldString: "x", newString: "y" }),
      toolResult("1", "ok"),
      { role: "assistant", content: "I'll add the flag to ask.go now." },
      assistantCall("2", "str_replace", { filePath: "cmd/synesis/ask.go", oldString: "a", newString: "b" }),
      toolResult("2", "ok"),
      { role: "assistant", content: "I'll verify the build." },
      assistantCall("3", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verbal_intent_without_action");
  });

  it("fires completion_claim_requires_task_update when tasks mentioned in text but no task tool calls", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      { role: "assistant", content: "I'll clean up the duplicate tasks and verify the bundle implementation is complete." },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", "Build successful"),
      { role: "assistant", content: "The implementation is complete. The build is successful." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("completion_claim_requires_task_update");
  });

  it("does not fire completion_claim when tasks are updated to done", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      { role: "assistant", content: "I'll clean up the duplicate tasks." },
      assistantCall("1", "todowrite", { todos: [{ id: "1", content: "Create bundle", status: "completed" }] }),
      toolResult("1", "ok"),
      { role: "assistant", content: "The task is complete." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
  });

  it("fires recovery rewrite block for verbal_intent_without_action", () => {
    const messages = [
      { role: "user", content: "implement feature" },
      { role: "assistant", content: "I'll implement the feature now." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("1", ""),
      { role: "assistant", content: "I'll check the implementation." },
      assistantCall("2", "bash", { command: "go test ./... 2>&1" }),
      toolResult("2", "ok"),
      { role: "assistant", content: "Let me verify the implementation." },
      assistantCall("3", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP declaring intent");
    expect(block).toContain("verbal_intent_without_action");
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

  it("pauses on exploration stall without edits (exploration_stall_no_edit)", () => {
    const messages = [
      { role: "user", content: "load the plan and begin work on next item" },
      assistantCall("1", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("1", "package bundle\nfunc Load() {}"),
      assistantCall("2", "search", { pattern: "dry-run|DryRun" }),
      toolResult("2", "pkg/ui/ui.go:287: DryRunOutput\npkg/ui/ui.go:302: PrintDryRun"),
      assistantCall("3", "search", { pattern: "dry-run|DryRun" }),
      toolResult("3", "pkg/ui/ui.go:287: DryRunOutput\npkg/ui/ui.go:302: PrintDryRun"),
      assistantCall("4", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("4", "package bundle\nfunc Load() {}"),
      assistantCall("5", "search", { pattern: "clipboard|Clipboard" }),
      toolResult("5", "pkg/clipboard/clipboard.go:1: package clipboard"),
      assistantCall("6", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("6", "package bundle\nfunc Load() {}"),
      assistantCall("7", "search", { pattern: "watch|Watch" }),
      toolResult("7", "pkg/watch/watch.go:1: package watch"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("exploration_stall_no_edit");
    expect(out.telemetry.trailingExplorationRunLength).toBeGreaterThanOrEqual(6);
  });

  it("does not fire exploration_stall when edits are present", () => {
    const messages = [
      { role: "user", content: "implement the feature" },
      assistantCall("1", "search", { pattern: "DryRun" }),
      toolResult("1", "pkg/ui/ui.go:287: DryRunOutput"),
      assistantCall("2", "read_file", { path: "pkg/ui/ui.go" }),
      toolResult("2", "package ui"),
      assistantCall("3", "str_replace", { filePath: "pkg/ui/ui.go", oldString: "x", newString: "y" }),
      toolResult("3", "ok"),
      assistantCall("4", "search", { pattern: "DryRun" }),
      toolResult("4", "pkg/ui/ui.go:287: DryRunOutput"),
      assistantCall("5", "read_file", { path: "pkg/ui/ui.go" }),
      toolResult("5", "package ui"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("exploration_stall_no_edit");
  });

  it("lowers exploration stall threshold when plan file was read", () => {
    const messages = [
      { role: "user", content: "load the plan and begin work" },
      assistantCall("1", "read_file", { path: "/Users/me/.claude/plans/my-plan.md" }),
      toolResult("1", "---\nname: Plan\ntodos:\n  - id: t1\n    status: pending\n---\n# Plan"),
      assistantCall("2", "search", { pattern: "bundle" }),
      toolResult("2", "pkg/bundle/bundle.go"),
      assistantCall("3", "search", { pattern: "bundle" }),
      toolResult("3", "pkg/bundle/bundle.go"),
      assistantCall("4", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("4", "package bundle"),
      assistantCall("5", "search", { pattern: "clipboard" }),
      toolResult("5", "pkg/clipboard/clipboard.go"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("exploration_stall_no_edit");
    expect(out.telemetry.hasPlanInContext).toBe(true);
  });

  it("exploration_stall recovery block mentions plan trust", () => {
    const messages = [
      { role: "user", content: "load the plan and begin work" },
      assistantCall("1", "read_file", { path: "/Users/me/.claude/plans/my-plan.md" }),
      toolResult("1", "---\nname: Plan\n---\n# Plan body"),
      assistantCall("2", "search", { pattern: "feature" }),
      toolResult("2", "some result"),
      assistantCall("3", "search", { pattern: "feature" }),
      toolResult("3", "some result"),
      assistantCall("4", "read_file", { path: "some/file.go" }),
      toolResult("4", "package main"),
      assistantCall("5", "search", { pattern: "feature v2" }),
      toolResult("5", "another result"),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    // With plan in context, both exploration_stall and no_progress_loop fire;
    // no_progress_loop takes priority as the broader signal.
    expect(decision.matchedRules).toContain("no_progress_loop");
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("ZERO code edits");
    expect(block).toContain("no_progress_loop");
  });

  it("does not fire exploration_stall for read-only investigation intent", () => {
    const messages = [
      { role: "user", content: "explain how the bundle feature works" },
      assistantCall("1", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("1", "package bundle"),
      assistantCall("2", "search", { pattern: "bundle" }),
      toolResult("2", "pkg/bundle/bundle.go"),
      assistantCall("3", "search", { pattern: "bundle" }),
      toolResult("3", "pkg/bundle/bundle.go"),
      assistantCall("4", "read_file", { path: "pkg/bundle/bundle.go" }),
      toolResult("4", "package bundle"),
      assistantCall("5", "search", { pattern: "Load" }),
      toolResult("5", "pkg/bundle/bundle.go:2: func Load"),
      assistantCall("6", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("6", "package main"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("exploration_stall_no_edit");
  });

  it("fires plan_reread_loop when plan file is read 3+ times with unchanged results", () => {
    const planPath = "/Users/test/.claude/plans/my-plan.md";
    const messages = [
      { role: "user", content: "load the plan and work on next item" },
      assistantCall("1", "read_file", { path: planPath }),
      toolResult("1", "---\ntitle: My Plan\ntodos:\n  - id: t1\n    content: Build feature\n    status: pending\n---\n# Plan\nBuild the feature."),
      { role: "assistant", content: "I'll review the plan and start working." },
      assistantCall("2", "read_file", { path: planPath }),
      toolResult("2", "unchanged since last read"),
      { role: "assistant", content: "I'll start implementing the feature." },
      assistantCall("3", "search", { pattern: "feature" }),
      toolResult("3", "src/main.ts:5: // feature placeholder"),
      { role: "assistant", content: "Let me read the plan again to check status." },
      assistantCall("4", "read_file", { path: planPath }),
      toolResult("4", "unchanged since last read"),
      { role: "assistant", content: "I'll mark the feature as done." },
      assistantCall("5", "read_file", { path: planPath }),
      toolResult("5", "unchanged since last read"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("plan_reread_loop");
    expect(out.reason).toBe("plan_reread_loop");
    expect(out.suggestedNextStep).toContain("re-read the plan file");
  });

  it("does not fire plan_reread_loop when plan was edited between reads", () => {
    const planPath = "/Users/test/.claude/plans/my-plan.md";
    const messages = [
      { role: "user", content: "load the plan and update it" },
      assistantCall("1", "read_file", { path: planPath }),
      toolResult("1", "---\ntitle: My Plan\n---\n# Plan content"),
      { role: "assistant", content: "I'll update the plan." },
      assistantCall("2", "str_replace", { filePath: planPath, oldString: "pending", newString: "done" }),
      toolResult("2", "ok"),
      { role: "assistant", content: "Let me verify the update." },
      assistantCall("3", "read_file", { path: planPath }),
      toolResult("3", "unchanged since last read"),
      assistantCall("4", "read_file", { path: planPath }),
      toolResult("4", "unchanged since last read"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("plan_reread_loop");
  });

  it("fires plan_reread_loop recovery block with correct guidance", () => {
    const planPath = "/Users/test/.claude/plans/my-plan.md";
    const messages = [
      { role: "user", content: "load plan and continue" },
      assistantCall("1", "read_file", { path: planPath }),
      toolResult("1", "---\ntitle: Plan\n---\n# Tasks"),
      { role: "assistant", content: "I'll check the plan status." },
      assistantCall("2", "read_file", { path: planPath }),
      toolResult("2", "unchanged"),
      { role: "assistant", content: "Let me re-read the plan." },
      assistantCall("3", "read_file", { path: planPath }),
      toolResult("3", "cached"),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP re-reading the plan file");
    expect(block).toContain("plan_reread_loop");
  });

  it("verbal_intent_without_action is not reset by bash mkdir commands", () => {
    const messages = [
      { role: "user", content: "implement keychain package" },
      { role: "assistant", content: "I'll implement the keychain package." },
      assistantCall("1", "bash", { command: "mkdir -p pkg/keychain" }),
      toolResult("1", ""),
      { role: "assistant", content: "I'll start implementing keychain." },
      assistantCall("2", "read_file", { path: "pkg/config/config.go" }),
      toolResult("2", "package config\n// config code"),
      { role: "assistant", content: "Let me implement the keychain now." },
      assistantCall("3", "bash", { command: "go build ./cmd/synesis 2>&1" }),
      toolResult("3", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("verbal_intent_without_action");
  });

  it("verbal_intent_without_action resets on real file edits (Write/Edit)", () => {
    const messages = [
      { role: "user", content: "implement keychain package" },
      { role: "assistant", content: "I'll implement the keychain package." },
      assistantCall("1", "str_replace", { filePath: "pkg/keychain/keychain.go", oldString: "", newString: "package keychain" }),
      toolResult("1", "ok"),
      { role: "assistant", content: "I'll add more code." },
      assistantCall("2", "str_replace", { filePath: "pkg/keychain/keychain.go", oldString: "package keychain", newString: "package keychain\n\nfunc Get() {}" }),
      toolResult("2", "ok"),
      { role: "assistant", content: "Let me verify." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verbal_intent_without_action");
  });

  it("fires no_progress_loop when verification and exploration interleave without edits", () => {
    const messages = [
      { role: "user", content: "validate keychain and update plan" },
      { role: "assistant", content: "I'll validate the keychain integration." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go vet ./... 2>&1" }),
      toolResult("2", ""),
      { role: "assistant", content: "Let me check what's been done." },
      assistantCall("3", "bash", { command: "git diff --stat HEAD" }),
      toolResult("3", "cmd/synesis/authcmd.go | 59 ++++\npkg/config/config.go | 13 +"),
      assistantCall("4", "search", { pattern: "keychain" }),
      toolResult("4", "cmd/synesis/authcmd.go\npkg/config/config.go\npkg/keychain/keychain.go"),
      { role: "assistant", content: "Let me check the files." },
      assistantCall("5", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("6", "package main\n\nimport \"synesis/pkg/keychain\"\n// full file content"),
      assistantCall("7", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("7", ""),
      assistantCall("8", "bash", { command: "git diff --stat HEAD 2>&1" }),
      toolResult("8", "cmd/synesis/authcmd.go | 59 ++++\npkg/config/config.go | 13 +"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("no_progress_loop");
    expect(out.reason).toBe("no_progress_loop");
    expect(out.suggestedNextStep).toContain("single code edit");
  });

  it("fires edit_failure_replay with stale-cache guidance when edits fail repeatedly", () => {
    const messages = [
      { role: "user", content: "add keychain integration" },
      { role: "assistant", content: "I'll add keychain to config.go." },
      assistantCall("1", "str_replace", { filePath: "pkg/config/config.go", oldString: "func Resolve()", newString: "func Resolve() with keychain" }),
      toolResult("1", "Error editing file: no match found for old_string"),
      { role: "assistant", content: "Let me try again." },
      assistantCall("2", "str_replace", { filePath: "pkg/config/config.go", oldString: "func Resolve()", newString: "func Resolve() with keychain" }),
      toolResult("2", "Error editing file: no match found for old_string"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("edit_failure_replay");
    expect(out.reason).toBe("edit_failure_replay");
    expect(out.suggestedNextStep).toContain("already contain the changes");
  });

  it("classifies git diff/status/log as verification commands", () => {
    const messages = [
      { role: "user", content: "check the state" },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "git diff --stat HEAD" }),
      toolResult("2", "3 files changed"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "git diff --stat HEAD" }),
      toolResult("4", "3 files changed"),
      assistantCall("5", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "git status" }),
      toolResult("6", "modified: pkg/config/config.go"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_stall_no_edit");
    expect(out.telemetry.trailingVerificationRunLength).toBeGreaterThanOrEqual(6);
  });

  it("does not fire no_progress_loop when edits are present", () => {
    const messages = [
      { role: "user", content: "implement feature" },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "search", { pattern: "keychain" }),
      toolResult("2", "found 3 files"),
      assistantCall("3", "read_file", { path: "pkg/config/config.go" }),
      toolResult("3", "package config"),
      assistantCall("4", "str_replace", { filePath: "pkg/config/config.go", oldString: "package config", newString: "package config\n\nimport \"keychain\"" }),
      toolResult("4", "ok"),
      assistantCall("5", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "go test ./... 2>&1" }),
      toolResult("6", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("no_progress_loop");
  });

  it("fires consecutive_edit_failures when edits fail on alternating files", () => {
    const messages = [
      { role: "user", content: "add keychain integration to both files" },
      { role: "assistant", content: "I'll add keychain to authcmd.go." },
      assistantCall("1", "update", { filePath: "cmd/synesis/authcmd.go", oldString: "func runAuth()", newString: "func runAuth() with keychain" }),
      toolResult("1", "Error editing file"),
      { role: "assistant", content: "Let me try config.go." },
      assistantCall("2", "update", { filePath: "pkg/config/config.go", oldString: "func Resolve()", newString: "func Resolve() with keychain" }),
      toolResult("2", "Error editing file"),
      { role: "assistant", content: "Let me try authcmd.go again." },
      assistantCall("3", "update", { filePath: "cmd/synesis/authcmd.go", oldString: "func runAuth(cmd", newString: "func runAuth(cmd with keychain" }),
      toolResult("3", "Error editing file"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("consecutive_edit_failures");
    expect(out.reason).toBe("consecutive_edit_failures");
    expect(out.suggestedNextStep).toContain("3 edit attempts ALL failed");
  });

  it("fires consecutive_edit_failures even with reads interleaved between failing edits", () => {
    const messages = [
      { role: "user", content: "add keychain" },
      assistantCall("1", "update", { filePath: "cmd/synesis/authcmd.go", oldString: "a", newString: "b" }),
      toolResult("1", "Error editing file"),
      assistantCall("2", "bash", { command: "git diff --stat HEAD 2>&1" }),
      toolResult("2", "authcmd.go | 59 ++++"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "update", { filePath: "cmd/synesis/authcmd.go", oldString: "c", newString: "d" }),
      toolResult("4", "Error editing file"),
      assistantCall("5", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("5", "package main"),
      assistantCall("6", "update", { filePath: "cmd/synesis/authcmd.go", oldString: "e", newString: "f" }),
      toolResult("6", "Error editing file"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("consecutive_edit_failures");
    expect(out.suggestedNextStep).toContain("already contain the changes");
  });

  it("does not fire consecutive_edit_failures when a successful edit follows failures", () => {
    const messages = [
      { role: "user", content: "fix the file" },
      assistantCall("1", "str_replace", { filePath: "foo.go", oldString: "a", newString: "b" }),
      toolResult("1", "Error editing file: no match"),
      assistantCall("2", "str_replace", { filePath: "foo.go", oldString: "c", newString: "d" }),
      toolResult("2", "Error editing file: no match"),
      assistantCall("3", "str_replace", { filePath: "foo.go", oldString: "real old", newString: "real new" }),
      toolResult("3", "Applied successfully"),
      assistantCall("4", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("4", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("consecutive_edit_failures");
  });

  it("consecutive_edit_failures recovery block mentions git diff and cat", () => {
    const messages = [
      { role: "user", content: "integrate keychain" },
      assistantCall("1", "update", { filePath: "a.go", oldString: "x", newString: "y" }),
      toolResult("1", "Error editing file"),
      assistantCall("2", "update", { filePath: "b.go", oldString: "x", newString: "y" }),
      toolResult("2", "Error editing file"),
      assistantCall("3", "update", { filePath: "c.go", oldString: "x", newString: "y" }),
      toolResult("3", "Error editing file"),
    ];
    const decision = evaluateExecutionGovernor(messages);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP editing");
    expect(block).toContain("consecutive_edit_failures");
    expect(block).toContain("git diff");
  });

  it("no_progress_loop recovery block includes correct guidance", () => {
    const messages = [
      { role: "user", content: "validate and complete" },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go vet ./... 2>&1" }),
      toolResult("2", ""),
      assistantCall("3", "search", { pattern: "keychain" }),
      toolResult("3", "found"),
      assistantCall("4", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("4", "package main"),
      assistantCall("5", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("5", ""),
      assistantCall("6", "bash", { command: "git diff --stat HEAD" }),
      toolResult("6", "9 files changed"),
      assistantCall("7", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("7", "package main"),
      assistantCall("8", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("8", ""),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP cycling");
    expect(block).toContain("no_progress_loop");
  });
});
