import { describe, expect, it } from "vitest";
import {
  evaluateExecutionGovernor,
  executionGovernorRecoveryRewriteBlock,
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  detectSessionPhase,
  inferGovernorPhaseFromMessages,
  governorPhaseToWorkflowPhase,
  type CommandEvent,
} from "../src/governance/execution-governor.js";

function assistantCall(id: string, name: string, args: unknown) {
  return { role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: args } }] };
}
function toolResult(id: string, content: string) {
  return { role: "tool", tool_call_id: id, content };
}
function assistantToolUse(id: string, name: string, input: unknown) {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input }] };
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

  it("treats 'String to replace not found in file' as edit failure replay", () => {
    const messages = [
      assistantCall("1", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      toolResult("1", "Error: String to replace not found in file."),
      assistantCall("2", "Read", { file_path: "cmd/synesis/ask.go" }),
      toolResult("2", "package main"),
      assistantCall("3", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      toolResult("3", "Error: String to replace not found in file."),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("edit_failure_replay");
    expect(out.matchedRules).toContain("edit_failure_replay");
  });

  it("detects replay from Claude tool_use edit failures without tool_call_id", () => {
    const messages = [
      assistantToolUse("u1", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      { role: "tool_result", name: "Edit", content: "Error: String to replace not found in file." },
      assistantToolUse("u2", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      { role: "tool_result", name: "Edit", content: "Error: String to replace not found in file." },
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("edit_failure_replay");
    expect(out.matchedRules).toContain("edit_failure_replay");
  });

  it("does not treat idempotent edit responses as edit failures", () => {
    const messages = [
      { role: "user", content: "wire up --print-request flag" },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "x", new_string: "y" }),
      toolResult("1", "No changes made: replacement already present in file"),
      assistantCall("2", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "x", new_string: "y" }),
      toolResult("2", "Already replaced in previous edit"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("edit_failure_replay");
    expect(out.matchedRules).not.toContain("consecutive_edit_failures");
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
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "a", new_string: "b" }),
      toolResult("1", "Applied edit"),
      assistantCall("2", "bash", { command: "go test ./..." }),
      toolResult("2", "ok"),
      assistantCall("3", "TaskCreate", { title: "Implement Clipboard Support" }),
      toolResult("3", "task created"),
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("completion_claim_requires_task_update");
    expect(out.matchedRules).toContain("completion_claim_requires_task_update");
  });

  it("pauses completion claims while activePlanStage is not finalized", () => {
    const messages = [
      { role: "user", content: "implement clipboard support" },
      { role: "assistant", content: "I've completed the clipboard support implementation." },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "a", new_string: "b" }),
      toolResult("1", "Applied edit"),
    ];
    const out = evaluateExecutionGovernor(messages as never, { activePlanStage: "implement" });
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("completion_claim_requires_task_update");
    expect(out.matchedRules).toContain("completion_claim_requires_task_update");
  });

  it("does not force completion-claim task-update pause while active repair is underway", () => {
    const messages = [
      { role: "user", content: "finish wiring ask command flags" },
      { role: "assistant", content: "This is already implemented." },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "model := fs.String", new_string: "model := fs.String" }),
      toolResult("1", "Error editing file: old_string not found"),
      assistantCall("2", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "model := fs.String", new_string: "model := fs.String" }),
      toolResult("2", "Error editing file: old_string not found"),
    ];
    const out = evaluateExecutionGovernor(messages as never, { activePlanStage: "implement" });
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
    expect(out.matchedRules).toContain("edit_failure_replay");
  });

  it("suppresses completion-claim pause while edit-context-miss repair is active", () => {
    const messages = [
      { role: "user", content: "verify and finish ask.go updates" },
      { role: "assistant", content: "This is already implemented." },
      assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("1", "package main"),
      assistantCall("2", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      toolResult("2", "Error: String to replace not found in file."),
    ];
    const out = evaluateExecutionGovernor(messages as never, {
      activePlanStage: "implement",
      editContextMissActive: true,
    });
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
    expect(out.matchedRules).not.toContain("verification_after_completion_claim");
  });

  it("does not pause completion claims from plan stage when activePlanStage is finalize", () => {
    const messages = [
      { role: "user", content: "implement clipboard support" },
      { role: "assistant", content: "I've completed the clipboard support implementation." },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "a", new_string: "b" }),
      toolResult("1", "Applied edit"),
    ];
    const out = evaluateExecutionGovernor(messages as never, { activePlanStage: "finalize" });
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
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

  it("advises git commit followthrough after git add without commit", () => {
    const messages = [
      { role: "user", content: "finish and commit the change" },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "a", new_string: "b" }),
      toolResult("1", "Applied edit"),
      assistantCall("2", "bash", { command: "git add -A" }),
      toolResult("2", ""),
      assistantCall("3", "bash", { command: "git status --short" }),
      toolResult("3", "M cmd/synesis/ask.go"),
      assistantCall("4", "bash", { command: "git diff --stat HEAD" }),
      toolResult("4", " cmd/synesis/ask.go | 2 +-"),
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(false);
    expect(out.reason).toBe("git_commit_followthrough");
    expect(out.matchedRules).toContain("git_commit_followthrough");
  });

  it("pauses dependency install replay when the same install command repeats", () => {
    const messages = [
      { role: "user", content: "fix the dependency issue and continue" },
      assistantCall("1", "bash", { command: "npm install" }),
      toolResult("1", "up to date"),
      assistantCall("2", "bash", { command: "npm install" }),
      toolResult("2", "up to date"),
    ];
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("dependency_install_replay");
    expect(out.matchedRules).toContain("dependency_install_replay");
  });

  it("pauses repeated successful narrow verification and asks for completion report", () => {
    const messages = [
      assistantCall("1", "bash", { command: "go test -c ./cmd/synesis 2>&1 && echo Build OK" }),
      toolResult("1", "Build OK"),
      assistantCall("2", "bash", { command: "go test -c ./cmd/synesis 2>&1 && echo Build OK" }),
      toolResult("2", "Build OK"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
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

  it("pauses repeated broad discovery loop on list_dir root", () => {
    const messages = [
      assistantCall("1", "list_dir", { path: "." }),
      toolResult("1", "cmd/\npkg/\nREADME.md"),
      assistantCall("2", "list_dir", { path: "." }),
      toolResult("2", "cmd/\npkg/\nREADME.md"),
      assistantCall("3", "list_dir", { path: "." }),
      toolResult("3", "cmd/\npkg/\nREADME.md"),
      assistantCall("4", "list_dir", { path: "." }),
      toolResult("4", "cmd/\npkg/\nREADME.md"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_discovery_repeat");
  });

  it("treats synesis_inspect_repo(list_dir=.) as broad discovery", () => {
    const messages = [
      assistantCall("1", "synesis_inspect_repo", { list_dir: "." }),
      toolResult("1", "repo inventory"),
      assistantCall("2", "synesis_inspect_repo", { list_dir: "." }),
      toolResult("2", "repo inventory"),
      assistantCall("3", "synesis_inspect_repo", { list_dir: "." }),
      toolResult("3", "repo inventory"),
      assistantCall("4", "synesis_inspect_repo", { list_dir: "." }),
      toolResult("4", "repo inventory"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("broad_discovery_repeat");
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
    // source_file_stale_reread fires at threshold 3 (before bounded_exploration_budget at 5)
    expect(out.matchedRules).toContain("source_file_stale_reread");
    // Recovery message should name the file and tell the model to take action
    expect(out.suggestedNextStep).toContain("a.go");
    expect(out.suggestedNextStep).toContain("Unchanged since last read");
  });

  it("does not trigger bounded_exploration_budget for reads outside sliding window", () => {
    const padMessages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [];
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

  it("pauses on failing verification churn without edits", () => {
    const messages = [
      { role: "user", content: "implement shell completion and tests" },
      assistantCall("1", "bash", { command: "go test ./... 2>&1" }),
      toolResult("1", "fail synesis.sh/synesis/cmd/synesis [setup failed]"),
      assistantCall("2", "read_file", { path: "cmd/synesis/completion.go" }),
      toolResult("2", "package main"),
      assistantCall("3", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("3", "cmd/synesis/completion.go:8:2: no required module provides package github.com/spf13/cobra"),
      assistantCall("4", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("4", "package main"),
      assistantCall("5", "bash", { command: "go test ./... 2>&1" }),
      toolResult("5", "fail synesis.sh/synesis/cmd/synesis [build failed]"),
      assistantCall("6", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("6", "cmd/synesis/completion_test.go:42:2: declared and not used: originalStdout"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_churn_no_edit");
    expect(out.matchedRules).toContain("verification_churn_no_edit");
    expect(out.telemetry.trailingVerificationRunLength).toBeGreaterThanOrEqual(4);
  });

  it("pauses on failing verification churn after a prior edit", () => {
    const messages = [
      { role: "user", content: "fix completion tests and continue" },
      assistantCall("1", "write", { file_path: "cmd/synesis/completion_test.go", content: "package main\n// updated test" }),
      toolResult("1", "Wrote 42 lines"),
      assistantCall("2", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("2", "# synesis.sh/synesis/cmd/synesis\ncmd/synesis/completion_test.go:11:2: declared and not used: originalStdout"),
      assistantCall("3", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1 | head -100" }),
      toolResult("3", "cmd/synesis/completion_test.go:11:2: declared and not used: originalStdout"),
      assistantCall("4", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("4", "cmd/synesis/completion_test.go:39:2: declared and not used: originalStdout"),
      assistantCall("5", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1 | head -50" }),
      toolResult("5", "cmd/synesis/completion_test.go:39:2: declared and not used: originalStdout"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_churn_no_edit");
    expect(out.matchedRules).toContain("verification_churn_no_edit");
  });

  it("treats repeated non-zero exit code test runs as verification churn", () => {
    const messages = [
      { role: "user", content: "fix completion tests and continue" },
      assistantCall("1", "write", { file_path: "cmd/synesis/completion_test.go", content: "package main\n// updated test" }),
      toolResult("1", "Wrote 42 lines"),
      assistantCall("2", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("2", "Exit code 1"),
      assistantCall("3", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("3", "Exit code 1"),
      assistantCall("4", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("4", "Exit code 1"),
      assistantCall("5", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("5", "Exit code 1"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("verification_churn_no_edit");
    expect(out.matchedRules).toContain("verification_churn_no_edit");
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
    // The 3 passing go test commands earn a productive bonus, raising the no_progress
    // threshold above the event count. verification_stall_no_edit correctly fires instead.
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_stall_no_edit");
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
    // Recovery now lists multi-language examples, not just Go
    expect(block).toContain("_test.go");
    expect(block).toContain(".test.ts");
    expect(block).toContain("test_*.py");
    expect(block).toContain("no_test_files_repeat");
  });

  // --- isProductiveCommand coverage: cross-ecosystem and zero-error false-failure ---

  it.each([
    ["pnpm test (passes)", "pnpm test", "1 passed"],
    ["yarn test (passes)", "yarn test", "Tests: 5 passed"],
    ["npm run test (passes)", "npm run test", "pass"],
    ["uv run pytest (passes)", "uv run pytest tests/ -v", "5 passed"],
    ["python -m pytest (passes)", "python -m pytest tests/test_completion.py", "passed"],
    ["cargo clippy (passes)", "cargo clippy -- -D warnings", ""],
    ["cargo check (passes)", "cargo check", "Finished"],
    ["tsc --noEmit (passes)", "tsc --noEmit", ""],
    ["CLI binary invocation", "./synesis completion --shell bash", "# bash completion"],
  ])("isProductiveCommand: %s is productive", (_label, cmd, result) => {
    // Use no_progress_loop as a proxy — productive commands raise its threshold
    // so it does NOT fire after a series of productive runs
    const messages = [
      { role: "user", content: "fix and verify" },
      assistantCall("1", "bash", { command: cmd }),
      toolResult("1", result),
      assistantCall("2", "bash", { command: "read:file.ts" }),
      toolResult("2", "content"),
      assistantCall("3", "bash", { command: cmd }),
      toolResult("3", result),
    ];
    const out = evaluateExecutionGovernor(messages);
    // The productive bonus should prevent no_progress_loop from firing
    // on just 3 events (well under the base threshold of 8)
    expect(out.matchedRules).not.toContain("no_progress_loop");
  });

  it("isProductiveCommand: '0 errors' output is NOT treated as failure", () => {
    // Before fix: "0 errors found" triggered isFailed=true → command not productive
    const messages = [
      { role: "user", content: "lint the project" },
      assistantCall("1", "bash", { command: "tsc --noEmit" }),
      toolResult("1", "Found 0 errors in 5 files"),
      assistantCall("2", "bash", { command: "ruff check ." }),
      toolResult("2", "0 errors"),
      assistantCall("3", "str_replace", { filePath: "src/main.ts", oldString: "x", newString: "y" }),
      toolResult("3", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
  });

  it("hasFailureSignature recognizes 'exit status 1' and 'Exited with code' variants", () => {
    // These are emitted by some shells and container runtimes
    const failResult = "Process exited with code 1";
    const messages = [
      { role: "user", content: "fix the test" },
      assistantCall("1", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("1", failResult),
      assistantCall("2", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("2", failResult),
      assistantCall("3", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("3", failResult),
      assistantCall("4", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("4", failResult),
    ];
    const out = evaluateExecutionGovernor(messages);
    // verification_churn_no_edit fires after 4+ repeated failures (churnThreshold = max(4, stallThreshold-2))
    expect(out.matchedRules).toContain("verification_churn_no_edit");
  });

  it("fires verbal_intent_without_action on repeated 'I'll' declarations without any tool calls", () => {
    // verbal_intent_without_action targets pure narration — model says "I'll..." but
    // calls NO tools at all. If tools are called, no_progress_loop handles unproductive loops.
    const messages = [
      { role: "user", content: "implement bundle files for the synesis CLI" },
      { role: "assistant", content: "I'll implement bundle files for the synesis CLI. Let me first check the current state." },
      { role: "assistant", content: "I'll implement bundle files. Let me check the current state and verify the implementation." },
      { role: "assistant", content: "I'll clean up the duplicate tasks and finish the bundle files implementation." },
      { role: "assistant", content: "Let me analyze the codebase and implement the missing features." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verbal_intent_without_action");
    expect(out.reason).toBe("verbal_intent_without_action");
    expect(out.suggestedNextStep).toContain("Stop narrating");
  });

  it("fires verification_intent_without_action on repeated test intent with no test command", () => {
    const messages = [
      { role: "user", content: "fix completion tests and continue" },
      { role: "assistant", content: "Let me run the completion tests to see what's failing." },
      { role: "assistant", content: "Let me run the completion tests to see what's failing." },
      { role: "assistant", content: "Let me run the tests to see what's failing." },
      assistantCall("1", "read_file", { path: "cmd/synesis/completion_test.go" }),
      toolResult("1", "package main\n\nfunc TestRunCompletion(t *testing.T) {}"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_intent_without_action");
    expect(out.reason).toBe("verification_intent_without_action");
    expect(out.suggestedNextStep).toContain("ONE targeted test command");
    expect(out.suggestedNextStep).toContain("NEXT response must be a tool call");
  });

  it("does not fire verification_intent_without_action when a test command actually runs", () => {
    const messages = [
      { role: "user", content: "fix completion tests and continue" },
      { role: "assistant", content: "Let me run the completion tests to see what's failing." },
      assistantCall("1", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }),
      toolResult("1", "# synesis.sh/synesis/cmd/synesis\nPASS"),
      { role: "assistant", content: "Let me run the tests once more after the fix." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_intent_without_action");
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

  it("does not fire completion_claim_requires_task_update from task words alone without active task context", () => {
    const messages = [
      { role: "user", content: "implement bundle files" },
      { role: "assistant", content: "I'll clean up the duplicate tasks and verify the bundle implementation is complete." },
      assistantCall("1", "bash", { command: "go build -o synesis.test ./cmd/synesis 2>&1" }),
      toolResult("1", "Build successful"),
      { role: "assistant", content: "The implementation is complete. The build is successful." },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
  });

  it("does not fire completion_claim_requires_task_update from stale historical task traffic", () => {
    const messages: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string; name?: string }> = [
      assistantCall("t1", "TaskCreate", { title: "old task" }),
      toolResult("t1", "task created"),
    ];
    for (let i = 0; i < 28; i += 1) {
      const id = `b${i}`;
      messages.push(assistantCall(id, "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1" }));
      messages.push(toolResult(id, "PASS"));
    }
    messages.push({ role: "assistant", content: "The completion feature is already implemented and working." });
    const out = evaluateExecutionGovernor(messages as never);
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
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
    // Pure narration with no tool calls at all
    const messages = [
      { role: "user", content: "implement feature" },
      { role: "assistant", content: "I'll implement the feature now." },
      { role: "assistant", content: "I'll check the implementation." },
      { role: "assistant", content: "Let me verify the implementation." },
      { role: "assistant", content: "I'll start working on the feature." },
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP declaring intent");
    expect(block).toContain("verbal_intent_without_action");
  });

  it("fires recovery rewrite block for verification_intent_without_action", () => {
    const messages = [
      { role: "user", content: "fix completion tests and continue" },
      { role: "assistant", content: "Let me run the completion tests to see what's failing." },
      { role: "assistant", content: "Let me run the completion tests to see what's failing." },
      { role: "assistant", content: "Let me run the tests to see what's failing." },
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("STOP saying you will run tests");
    expect(block).toContain("verification_intent_without_action");
    expect(block).toContain("NEXT response must be one tool call");
  });

  it("builds user-facing hard stop message for intent loops", () => {
    const message = buildExecutionGovernorHardStopUserMessage({
      consecutiveRecoveryFires: 5,
      matchedRules: ["verification_intent_without_action", "no_progress_loop"],
    });
    expect(message).toContain("GOVERNOR PAUSE");
    expect(message).toContain("agent will not continue automatically");
    expect(message).toContain("Choose the next action");
    expect(message).toContain("Run one targeted test command now");
    expect(message).not.toContain("You MUST now do ONE of the following");
  });

  it("builds user-facing hard stop message for general loops", () => {
    const message = buildExecutionGovernorHardStopUserMessage({
      consecutiveRecoveryFires: 5,
      matchedRules: ["verification_churn_no_edit"],
    });
    expect(message).toContain("Reason: verification_churn_no_edit");
    expect(message).toContain("Continue with one focused fix");
    expect(message).toContain("targeted verification command");
  });

  it("builds transport-agnostic pause envelope for intent loops", () => {
    const envelope = buildExecutionGovernorPauseEnvelope({
      matchedRules: ["verification_intent_without_action", "no_progress_loop"],
      consecutiveRecoveryFires: 5,
      hardStopThreshold: 5,
    });
    expect(envelope.status).toBe("paused");
    expect(envelope.required_user_action).toBe(true);
    expect(envelope.pause_reason).toBe("verification_intent_without_action");
    expect(envelope.next_automatic_step_allowed).toBe(false);
    expect(envelope.next_actions.map((a) => a.id)).toContain("run_targeted_test");
    expect(envelope.next_actions.map((a) => a.id)).toContain("apply_one_edit");
    expect(envelope.default_recommended_action).toBe("apply_one_edit");
  });

  it("builds transport-agnostic pause envelope for general loops", () => {
    const envelope = buildExecutionGovernorPauseEnvelope({
      matchedRules: ["verification_churn_no_edit"],
      consecutiveRecoveryFires: 5,
      hardStopThreshold: 5,
    });
    expect(envelope.pause_reason).toBe("verification_churn_no_edit");
    expect(envelope.next_actions.map((a) => a.id)).toContain("continue_with_fix");
    expect(envelope.next_actions.map((a) => a.id)).toContain("continue_with_verification");
    expect(envelope.default_recommended_action).toBe("continue_with_fix");
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
    expect(block).toContain("STOP cycling");
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

  it("does not fire exploration_stall for scan/verify/ensure investigation intent", () => {
    const messages = [
      { role: "user", content: "scan the repo and make sure every feature is implemented" },
      assistantCall("1", "search", { pattern: "repl|template" }),
      toolResult("1", "cmd/synesis/repl.go\ncmd/synesis/template.go"),
      assistantCall("2", "read_file", { path: "cmd/synesis/repl.go" }),
      toolResult("2", "package main\n\nfunc replCmd()"),
      assistantCall("3", "read_file", { path: "cmd/synesis/template.go" }),
      toolResult("3", "package main\n\nfunc templateCmd()"),
      assistantCall("4", "read_file", { path: "pkg/repl/repl.go" }),
      toolResult("4", "package repl\n\nfunc Start()"),
      assistantCall("5", "read_file", { path: "pkg/template/template.go" }),
      toolResult("5", "package template\n\nfunc Load()"),
      assistantCall("6", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("6", "package main\n\nfunc main()"),
      assistantCall("7", "read_file", { path: "pkg/config/config.go" }),
      toolResult("7", "package config\n\nfunc Resolve()"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("exploration_stall_no_edit");
    expect(out.matchedRules).not.toContain("no_progress_loop");
    expect(out.matchedRules).not.toContain("verbal_intent_without_action");
    expect(out.pause).toBe(false);
  });

  it("does not fire exploration_stall for validate/check investigation intent", () => {
    const messages = [
      { role: "user", content: "validate keychain and check all features are complete" },
      assistantCall("1", "search", { pattern: "keychain" }),
      toolResult("1", "pkg/keychain/keychain.go"),
      assistantCall("2", "read_file", { path: "pkg/keychain/keychain.go" }),
      toolResult("2", "package keychain"),
      assistantCall("3", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("3", "package main"),
      assistantCall("4", "search", { pattern: "auth" }),
      toolResult("4", "cmd/synesis/authcmd.go"),
      assistantCall("5", "read_file", { path: "pkg/config/config.go" }),
      toolResult("5", "package config"),
      assistantCall("6", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("6", "package main"),
      assistantCall("7", "search", { pattern: "session" }),
      toolResult("7", "pkg/session/session.go"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("exploration_stall_no_edit");
    expect(out.pause).toBe(false);
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

  it("treats typed unchanged snapshot status as cached reread signal", () => {
    const planPath = "/Users/test/.claude/plans/my-plan.md";
    const unchanged = JSON.stringify({
      kind: "synesis_file_read",
      status: "ok/unchanged_snapshot_still_visible",
      path: planPath,
    });
    const messages = [
      { role: "user", content: "load plan and continue" },
      assistantCall("1", "read_file", { path: planPath }),
      toolResult("1", "---\ntitle: Plan\n---\n# tasks"),
      assistantCall("2", "read_file", { path: planPath }),
      toolResult("2", unchanged),
      assistantCall("3", "read_file", { path: planPath }),
      toolResult("3", unchanged),
      assistantCall("4", "read_file", { path: planPath }),
      toolResult("4", unchanged),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("plan_reread_loop");
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

  it("fires verbal_intent_without_action for intent + read/search churn without progress", () => {
    const messages = [
      { role: "user", content: "implement keychain package" },
      { role: "assistant", content: "I'll implement the keychain package." },
      assistantCall("1", "read_file", { path: "pkg/config/config.go" }),
      toolResult("1", "package config\n// config code"),
      { role: "assistant", content: "I'll start implementing keychain." },
      assistantCall("2", "search", { pattern: "keychain|Keychain" }),
      toolResult("2", "pkg/keychain/keychain.go"),
      { role: "assistant", content: "Let me implement the keychain now." },
      assistantCall("3", "read_file", { path: "pkg/keychain/keychain.go" }),
      toolResult("3", "package keychain"),
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

  // --- isVerificationCommand coverage matrix ---

  it("recognizes vitest run as a verification command (does not fire verification_intent_without_action)", () => {
    const messages = [
      { role: "user", content: "fix completion tests and verify" },
      { role: "assistant", content: "Let me run the tests to verify the completion feature works." },
      assistantCall("1", "bash", { command: "npx vitest run tests/execution-governor.test.ts" }),
      toolResult("1", "✓ 128 tests passed"),
      { role: "assistant", content: "Let me run the tests to verify the completion feature works." },
      assistantCall("2", "bash", { command: "vitest run --reporter=verbose" }),
      toolResult("2", "✓ all pass"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_intent_without_action");
  });

  it("recognizes uv run pytest as a verification command", () => {
    const messages = [
      { role: "user", content: "fix the indexer tests" },
      { role: "assistant", content: "Let me run the tests to verify." },
      assistantCall("1", "bash", { command: "uv run pytest tests/ -v" }),
      toolResult("1", "PASSED"),
      { role: "assistant", content: "Let me run the tests to verify the fix." },
      assistantCall("2", "bash", { command: "uv run pytest tests/test_indexer.py -v" }),
      toolResult("2", "PASSED"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_intent_without_action");
  });

  it("recognizes CLI binary invocation as a verification command (./synesis completion)", () => {
    // When testing a CLI feature, the model builds then runs the binary.
    // This must count as a verification so verification_intent_without_action doesn't fire.
    const messages = [
      { role: "user", content: "implement shell completion for synesis CLI" },
      { role: "assistant", content: "Let me run the completion to verify it works." },
      assistantCall("1", "bash", { command: "go build -o /tmp/synesis ./cmd/synesis && /tmp/synesis completion --shell bash" }),
      toolResult("1", "# bash completion for synesis\ncomplete -F __start_synesis synesis"),
      { role: "assistant", content: "Let me run the tests to verify the completion feature works." },
      assistantCall("2", "bash", { command: "./synesis completion --shell fish" }),
      toolResult("2", "complete -c synesis -f"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_intent_without_action");
  });

  it("recognizes go test with -run flag and output capture as verification", () => {
    const messages = [
      { role: "user", content: "fix the completion test" },
      { role: "assistant", content: "Let me run the targeted test to verify the fix." },
      assistantCall("1", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v 2>&1 | head -50" }),
      toolResult("1", "--- PASS: TestRunCompletion (0.01s)"),
      { role: "assistant", content: "Let me run the tests to verify the completion feature." },
      assistantCall("2", "bash", { command: "go test -v ./cmd/synesis -run TestCompletion 2>&1" }),
      toolResult("2", "PASS"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_intent_without_action");
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
      assistantCall("9", "read_file", { path: "pkg/keychain/keychain.go" }),
      toolResult("9", "package keychain"),
      assistantCall("10", "bash", { command: "git status" }),
      toolResult("10", "On branch main\nnothing to commit"),
      assistantCall("11", "bash", { command: "go vet ./... 2>&1" }),
      toolResult("11", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("no_progress_loop");
    expect(out.reason).toBe("no_progress_loop");
    expect(out.suggestedNextStep).toContain("code edit");
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
      assistantCall("9", "read_file", { path: "pkg/config/config.go" }),
      toolResult("9", "package config"),
      assistantCall("10", "bash", { command: "git status" }),
      toolResult("10", "nothing to commit"),
      assistantCall("11", "search", { pattern: "keychain" }),
      toolResult("11", "found"),
      assistantCall("12", "read_file", { path: "cmd/synesis/authcmd.go" }),
      toolResult("12", "package main"),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    // authcmd.go was read 3× (events 4, 7, 12) → source_file_stale_reread fires first
    expect(block).toContain("authcmd.go");
    expect(block).toContain("Unchanged since last read");
  });

  // --- source_file_stale_reread: the main.go repeated read loop ---

  it("source_file_stale_reread fires after reading same source file 3 times without edit", () => {
    const messages = [
      { role: "user", content: "finish the completion feature" },
      { role: "assistant", content: "Let me check if the completion command is properly wired into main.go and run a simple test:" },
      assistantCall("1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("1", "package main\n\nfunc main() {"),
      { role: "assistant", content: "Let me check the current state of main.go to see how completion is integrated, and then run the tests:" },
      assistantCall("2", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("2", "package main\n\nfunc main() {"),
      { role: "assistant", content: "Let me check the main.go file to see how completion is integrated:" },
      assistantCall("3", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("3", "package main\n\nfunc main() {"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("source_file_stale_reread");
    expect(out.suggestedNextStep).toContain("main.go");
    expect(out.suggestedNextStep).toContain("Unchanged since last read");
    expect(out.suggestedNextStep).toContain("3 times");
  });

  it("source_file_stale_reread does NOT fire if file was edited between reads", () => {
    const messages = [
      { role: "user", content: "finish the completion feature" },
      assistantCall("1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("1", "package main\n\nfunc main() {"),
      assistantCall("2", "str_replace", { path: "cmd/synesis/main.go", oldString: "}", newString: "}\n// new" }),
      toolResult("2", "ok"),
      assistantCall("3", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("3", "package main\n\nfunc main() {}\n// new"),
      assistantCall("4", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("4", "package main\n\nfunc main() {}\n// new"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // After an edit the read counter resets — only 2 reads since the edit, below threshold
    expect(out.matchedRules).not.toContain("source_file_stale_reread");
  });

  it("source_file_stale_reread does NOT fire when the edit tool is named Write", () => {
    const messages = [
      { role: "user", content: "finish the completion feature" },
      assistantCall("1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("1", "package main\n\nfunc main() {"),
      assistantCall("2", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("2", "package main\n\nfunc main() {"),
      assistantCall("3", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("3", "package main\n\nfunc main() {"),
      assistantCall("4", "Write", { file_path: "cmd/synesis/main.go", content: "package main\n\nfunc main() {}\n// updated" }),
      toolResult("4", "Updated cmd/synesis/main.go successfully"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("source_file_stale_reread");
  });

  it("source_file_stale_reread does NOT fire during investigation-only sessions", () => {
    const messages = [
      { role: "user", content: "explain how main.go is structured" },
      assistantCall("1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("1", "package main"),
      assistantCall("2", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("2", "package main"),
      assistantCall("3", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("3", "package main"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // Investigation-only intent suppresses the stale reread rule
    expect(out.matchedRules).not.toContain("source_file_stale_reread");
  });

  // --- verification_intent_without_action: "check if integrated, and then run tests" ---

  it("verification_intent_without_action fires when model says 'check if wired and run tests' but only reads", () => {
    const makeMessages = (preamble: string) => [
      { role: "user", content: "finish the completion feature" },
      { role: "assistant", content: preamble },
      assistantCall("1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("1", "package main"),
      { role: "assistant", content: preamble },
      assistantCall("2", "read_file", { path: "cmd/synesis/completion.go" }),
      toolResult("2", "package main"),
    ];
    // "check if X is wired... and then run tests" should be counted as verification intent
    const out = evaluateExecutionGovernor(makeMessages(
      "Let me check if the completion command is properly wired into main.go and run a simple test:"
    ));
    expect(out.matchedRules).toContain("verification_intent_without_action");
  });

  it("fires verification_after_completion_claim when model says 'already done' then keeps verifying", () => {
    const messages = [
      { role: "user", content: "implement keychain integration" },
      { role: "assistant", content: "The keychain integration is already done from the previous session. Let me verify." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go vet ./... 2>&1" }),
      toolResult("2", ""),
      assistantCall("3", "bash", { command: "git diff --stat HEAD" }),
      toolResult("3", "authcmd.go | 59 ++++\nconfig.go | 13 +"),
      { role: "assistant", content: "Let me check what remains." },
      assistantCall("4", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("4", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_after_completion_claim");
    expect(out.reason).toBe("verification_after_completion_claim");
    expect(out.suggestedNextStep).toContain("acknowledged the work is already done");
  });

  it("fires verification_after_completion_claim with 'already implemented' phrasing", () => {
    const messages = [
      { role: "user", content: "add keychain to config" },
      { role: "assistant", content: "Good news — looking at the files, the Keychain integration is already implemented in both authcmd.go and config.go." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1 && echo ALL OK" }),
      toolResult("1", "ALL OK"),
      assistantCall("2", "bash", { command: "git status --short" }),
      toolResult("2", "M cmd/synesis/authcmd.go\nM pkg/config/config.go"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis/ 2>&1 && echo BUILD OK" }),
      toolResult("3", "BUILD OK"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_after_completion_claim");
  });

  it("does not fire verification_after_completion_claim when model takes action after claim", () => {
    const messages = [
      { role: "user", content: "implement keychain" },
      { role: "assistant", content: "The keychain integration is already done. Let me update the plan." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "str_replace", { filePath: ".claude/plans/plan.md", oldString: "- [ ] keychain", newString: "- [x] keychain" }),
      toolResult("2", "ok"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).not.toContain("verification_after_completion_claim");
  });

  it("verification_after_completion_claim recovery block mentions git commit", () => {
    const messages = [
      { role: "user", content: "finish keychain" },
      { role: "assistant", content: "The keychain integration is already done from the previous session." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "git diff --stat HEAD" }),
      toolResult("2", "9 files changed"),
      assistantCall("3", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("3", ""),
      assistantCall("4", "bash", { command: "git status" }),
      toolResult("4", "M authcmd.go"),
    ];
    const decision = evaluateExecutionGovernor(messages);
    expect(decision.pause).toBe(true);
    const block = executionGovernorRecoveryRewriteBlock(decision);
    expect(block).toContain("You ALREADY said the work is done");
    expect(block).toContain("git add");
    expect(block).toContain("verification_after_completion_claim");
  });
});

describe("detectSessionPhase", () => {
  function ev(command: string, toolName = "bash", resultSignature = ""): CommandEvent {
    return { command, toolName, resultSignature };
  }

  it("defaults to explore with investigation intent and no events", () => {
    expect(detectSessionPhase([], "scan the repo", [], false)).toBe("explore");
  });

  it("defaults to edit (all rules) with no investigation intent and no events", () => {
    expect(detectSessionPhase([], "fix the bug", [], false)).toBe("edit");
  });

  it("stays in explore during reads and searches with investigation intent", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("search:pattern", "search"),
      ev("read:src/util.ts", "read_file"),
    ];
    expect(detectSessionPhase(events, "what does this codebase do", [], false)).toBe("explore");
  });

  it("uses edit phase for reads without investigation intent", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("search:pattern", "search"),
    ];
    expect(detectSessionPhase(events, "fix the bug", [], false)).toBe("edit");
  });

  it("transitions to edit on first file write", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("edit:src/main.ts", "str_replace", "ok"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], false)).toBe("edit");
  });

  it("transitions to verify when build/test follows an edit", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash"),
    ];
    expect(detectSessionPhase(events, "fix and test", ["src/main.ts"], false)).toBe("verify");
  });

  it("cycles back to edit when another edit follows verification", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash"),
      ev("edit:src/main.ts", "str_replace", "ok"),
    ];
    expect(detectSessionPhase(events, "fix failing tests", ["src/main.ts"], false)).toBe("edit");
  });

  it("transitions to finalize on completion claim with green verification", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash", "ok"),
      ev("git status", "bash"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], true)).toBe("finalize");
  });

  it("does not transition to report when verification is failing", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash", "fail pkg/main"),
      ev("go test ./...", "bash", "fail pkg/main"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], true)).toBe("verify");
  });

  it("falls back to report on completion claim without green verification evidence", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("git status", "bash"),
      ev("git diff --stat", "bash"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], true)).toBe("report");
  });

  it("stays in edit when completion claim is followed by edit-context misses", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("edit:src/main.ts", "str_replace", "error editing file: old_string not found"),
      ev("read:src/main.ts", "read_file", "unchanged since last read"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], true)).toBe("edit");
  });

  it("stays in edit if completion claim followed by last event being an edit", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash"),
      ev("edit:src/main.ts", "str_replace", "ok"),
    ];
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], true)).toBe("edit");
  });

  it("investigation intent keeps phase as explore even when tests run", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("go test ./...", "bash"),
      ev("read:src/util.ts", "read_file"),
    ];
    expect(detectSessionPhase(events, "scan repo and make sure every feature is implemented", [], false)).toBe("explore");
  });

  // --- phase FSM: verify transition with cross-ecosystem runners ---

  it.each([
    ["npx vitest", "npx vitest run"],
    ["vitest", "vitest run --reporter=verbose"],
    ["jest", "npx jest --testPathPattern=completion"],
    ["npm run test", "npm run test"],
    ["pnpm test", "pnpm test"],
    ["uv run pytest", "uv run pytest tests/ -v"],
    ["python -m pytest", "python -m pytest tests/test_completion.py -v"],
    ["tsc --noEmit", "tsc --noEmit"],
    ["cargo clippy", "cargo clippy -- -D warnings"],
    ["CLI binary", "go build -o /tmp/synesis ./cmd/synesis && /tmp/synesis completion --shell bash"],
  ])("edit→verify transition triggered by %s", (_label, testCmd) => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev(testCmd, "bash"),
    ];
    const phase = detectSessionPhase(events, "fix the bug", ["src/main.ts"], false);
    expect(phase).toBe("verify");
  });

  it("git status alone after edit does NOT advance to verify (stays edit)", () => {
    const events = [
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("git status", "bash"),
      ev("git diff --stat", "bash"),
    ];
    // git diff/status are inspection, not test execution — should not trigger verify
    expect(detectSessionPhase(events, "fix the bug", ["src/main.ts"], false)).toBe("edit");
  });

  it("does not stay in explore for investigation if edits occurred", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("edit:src/main.ts", "str_replace", "ok"),
      ev("go test ./...", "bash"),
    ];
    expect(detectSessionPhase(events, "scan repo and fix issues", ["src/main.ts"], false)).toBe("verify");
  });

  it("failed edit does not transition to edit phase from explore", () => {
    const events = [
      ev("read:src/main.ts", "read_file"),
      ev("edit:src/main.ts", "str_replace", "error editing file: old_string not found"),
    ];
    // With investigation intent, stays in explore despite failed edit
    expect(detectSessionPhase(events, "review the codebase", [], false)).toBe("explore");
    // Without investigation intent, default is edit (all rules apply)
    expect(detectSessionPhase(events, "fix something", [], false)).toBe("edit");
  });
});

describe("phase-aware rule gating", () => {
  it("explore phase suppresses no_progress_loop", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
    ];
    for (let i = 0; i < 14; i++) {
      messages.push(assistantCall(`r${i}`, "read_file", { path: `src/file${i}.ts` }));
      messages.push(toolResult(`r${i}`, `content of file${i}`));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("explore");
    expect(out.matchedRules).not.toContain("no_progress_loop");
    expect(out.matchedRules).not.toContain("exploration_stall_no_edit");
    expect(out.matchedRules).not.toContain("verbal_intent_without_action");
  });

  it("explore phase still fires bounded_exploration_budget on redundant re-reads", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "explain how the auth module works" },
    ];
    for (let i = 0; i < 6; i++) {
      messages.push(assistantCall(`r${i}`, "read_file", { path: "src/auth.ts" }));
      messages.push(toolResult(`r${i}`, "auth module content"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("explore");
    expect(out.matchedRules).toContain("bounded_exploration_budget");
  });

  it("edit phase fires exploration_stall_no_edit normally", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "fix the bug in auth.ts" },
      assistantCall("e1", "str_replace", { filePath: "src/auth.ts", oldString: "old", newString: "new" }),
      toolResult("e1", "ok"),
    ];
    for (let i = 0; i < 8; i++) {
      messages.push(assistantCall(`r${i}`, "read_file", { path: `src/file${i}.ts` }));
      messages.push(toolResult(`r${i}`, `content of file${i}`));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("edit");
  });

  it("verify phase fires verification_stall_no_edit on repeated verification", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "fix the bug and verify" },
      assistantCall("e1", "str_replace", { filePath: "src/main.ts", oldString: "old", newString: "new" }),
      toolResult("e1", "ok"),
    ];
    for (let i = 0; i < 7; i++) {
      messages.push(assistantCall(`v${i}`, "bash", { command: "go test ./..." }));
      messages.push(toolResult(`v${i}`, "ok"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("verify");
    expect(out.matchedRules).toContain("verification_stall_no_edit");
  });

  it("finalize phase fires verification_after_completion_claim", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "implement feature X" },
      { role: "assistant", content: "The feature is already implemented and all tests pass." },
      assistantCall("1", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("1", ""),
      assistantCall("2", "bash", { command: "go vet ./... 2>&1" }),
      toolResult("2", ""),
      assistantCall("3", "bash", { command: "git diff --stat HEAD" }),
      toolResult("3", "auth.go | 10 +++"),
      assistantCall("4", "bash", { command: "go build ./cmd/synesis/ 2>&1" }),
      toolResult("4", ""),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("finalize");
    expect(out.matchedRules).toContain("verification_after_completion_claim");
  });

  it("finalize phase enforces completion action when model keeps verifying", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "implement feature X and finish" },
      assistantCall("e1", "str_replace", { filePath: "src/main.ts", oldString: "old", newString: "new" }),
      toolResult("e1", "ok"),
      { role: "assistant", content: "Feature is complete and verified." },
      assistantCall("v1", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("v1", "ok  synesis.sh/synesis/cmd/synesis"),
      assistantCall("v2", "bash", { command: "go test ./cmd/synesis -run TestRunCompletion -v" }),
      toolResult("v2", "ok  synesis.sh/synesis/cmd/synesis"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("finalize");
    expect(out.matchedRules).toContain("finalize_action_required");
    expect(out.reason).toBe("finalize_action_required");
  });

  it("phase telemetry is present on all decisions", () => {
    const messages = [
      { role: "user", content: "hello" },
      assistantCall("1", "read_file", { path: "README.md" }),
      toolResult("1", "readme content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBeDefined();
    expect(["explore", "edit", "verify", "report", "finalize"]).toContain(out.telemetry.phase);
  });

  it("exits explore when follow-up user message has implementation intent", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      assistantCall("r1", "read_file", { path: "src/main.ts" }),
      toolResult("r1", "main content"),
      assistantCall("r2", "bash", { command: "go test ./..." }),
      toolResult("r2", "ok"),
      { role: "assistant", content: "All features are implemented. What would you like me to focus on?" },
      { role: "user", content: "Both tests and completion" },
      assistantCall("r3", "read_file", { path: "src/main.ts" }),
      toolResult("r3", "main content"),
      assistantCall("r4", "read_file", { path: "src/tests.ts" }),
      toolResult("r4", "test content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("edit");
    expect(out.matchedRules).not.toContain("bounded_exploration_budget");
  });

  it("stays in explore when latest user message is still investigation", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      assistantCall("r1", "read_file", { path: "src/main.ts" }),
      toolResult("r1", "main content"),
      { role: "assistant", content: "Found several features. Let me check more." },
      { role: "user", content: "yes, review all the modules" },
      assistantCall("r2", "read_file", { path: "src/auth.ts" }),
      toolResult("r2", "auth content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("explore");
  });

  it("exits explore when user answers AskUserQuestion with implementation intent", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      assistantCall("r1", "read_file", { path: "src/main.ts" }),
      toolResult("r1", "main content"),
      assistantCall("r2", "bash", { command: "go test ./..." }),
      toolResult("r2", "ok"),
      { role: "assistant", content: "All features are implemented.", tool_calls: [{ id: "ask1", function: { name: "AskUserQuestion", arguments: '{"questions":"What to do next?"}' } }] },
      { role: "tool", tool_call_id: "ask1", content: "Both tests and completion" },
      assistantCall("r3", "read_file", { path: "src/test.ts" }),
      toolResult("r3", "test content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("edit");
  });

  it("stays in explore when user answers AskUserQuestion with investigation intent", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      assistantCall("r1", "read_file", { path: "src/main.ts" }),
      toolResult("r1", "main content"),
      { role: "assistant", content: "What next?", tool_calls: [{ id: "ask1", function: { name: "AskUserQuestion", arguments: '{"questions":"What to do next?"}' } }] },
      { role: "tool", tool_call_id: "ask1", content: "Review and verify all existing implementations are complete" },
      assistantCall("r2", "read_file", { path: "src/auth.ts" }),
      toolResult("r2", "auth content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).toBe("explore");
  });

  it("pauses when the same AskUserQuestion is repeated after user already answered", () => {
    const questionPayload = {
      questions: "[{\"question\":\"All 15 features are already implemented. What would you like me to focus on?\"}]",
    };
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      { role: "assistant", content: "What next?", tool_calls: [{ id: "ask1", function: { name: "AskUserQuestion", arguments: questionPayload } }] },
      { role: "tool", tool_call_id: "ask1", content: "Both tests and completion" },
      { role: "assistant", content: "Confirming focus...", tool_calls: [{ id: "ask2", function: { name: "AskUserQuestion", arguments: questionPayload } }] },
      { role: "tool", tool_call_id: "ask2", content: "Both tests and completion" },
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.reason).toBe("repeat_user_prompt_loop");
    expect(out.matchedRules).toContain("repeat_user_prompt_loop");
  });

  it("stale completion claim before user redirect does not lock phase to report", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan repo and make sure every feature is implemented" },
      assistantCall("r1", "read_file", { path: "src/main.ts" }),
      toolResult("r1", "main content"),
      assistantCall("r2", "bash", { command: "go test ./..." }),
      toolResult("r2", "ok"),
      // Model claims completion and asks user what to do next
      { role: "assistant", content: "The codebase already has all 15 features implemented. What would you like me to focus on?", tool_calls: [{ id: "ask1", function: { name: "AskUserQuestion", arguments: '{"questions":"next step"}' } }] },
      // User redirects to new work
      { role: "tool", tool_call_id: "ask1", content: "Both tests and completion" },
      // Model starts working on the new request
      assistantCall("r3", "read_file", { path: "src/test.ts" }),
      toolResult("r3", "test content"),
      assistantCall("r4", "read_file", { path: "src/auth.ts" }),
      toolResult("r4", "auth content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // Should NOT be report — the user redirected to new work after the claim
    expect(out.telemetry.phase).not.toBe("report");
    expect(out.telemetry.phase).toBe("edit");
  });

  it("first-response completion claim from context summary does not lock to report phase", () => {
    // When the model's very first response references prior context ("Based on the summary,
    // X is complete") the governor should NOT lock into report phase. With fewer than 3
    // events, the model is still orienting — it needs exploration tools.
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "scan the codebase and confirm all features are implemented" },
      { role: "assistant", content: "Based on the previous conversation summary, the completion implementation is complete. Let me verify by reading the files." },
      assistantCall("r1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("r1", "main content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // Should NOT be report — only exploration events, no edits or verification
    expect(out.telemetry.phase).not.toBe("report");
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
    expect(out.pause).toBe(false);
  });

  it("completion claim during pure exploration (many reads) does not trigger report phase", () => {
    // A "big prompt" scan: model reads many files while referencing prior context.
    // All events are reads — no edits, no verification. Governor should stay in edit,
    // not lock to report and strip exploration tools.
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "implement the remaining features and verify everything works" },
      { role: "assistant", content: "I'll analyze the codebase. Based on previous context, the completion feature is already implemented. Let me verify the rest." },
      assistantCall("r1", "read_file", { path: "cmd/synesis/main.go" }),
      toolResult("r1", "main content"),
      assistantCall("r2", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("r2", "ask content"),
      assistantCall("r3", "grep", { pattern: "func run" }),
      toolResult("r3", "3 matches"),
      assistantCall("r4", "read_file", { path: "cmd/synesis/chat.go" }),
      toolResult("r4", "chat content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.telemetry.phase).not.toBe("report");
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
  });

  // ── Regression fixes ────────────────────────────────────────────────────────

  it("investigation-only is downgraded to false when failures are present", () => {
    // "make sure X works" is normally classified as investigation-only, which would
    // block churn rules. Failures override that classification so the governor fires.
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "can we make sure the completion task is done and works as expected" },
      assistantCall("t1", "bash", { command: "go test ./cmd/synesis -v" }),
      toolResult("t1", "PASS\nok cmd/synesis 0.1s"),
      assistantCall("b1", "bash", { command: "./synesis completion --help 2>&1" }),
      toolResult("b1", "Error: Exit code 1\nError: unsupported shell: --help"),
      assistantCall("t2", "bash", { command: "go test ./cmd/synesis -v" }),
      toolResult("t2", "PASS\nok cmd/synesis 0.1s"),
      assistantCall("b2", "bash", { command: "./synesis completion --help 2>&1" }),
      toolResult("b2", "Error: Exit code 1\nError: unsupported shell: --help"),
      assistantCall("t3", "bash", { command: "go test ./cmd/synesis -v" }),
      toolResult("t3", "PASS\nok cmd/synesis 0.1s"),
      assistantCall("b3", "bash", { command: "./synesis completion --help 2>&1" }),
      toolResult("b3", "Error: Exit code 1\nError: unsupported shell: --help"),
      assistantCall("t4", "bash", { command: "go test ./cmd/synesis -v" }),
      toolResult("t4", "PASS\nok cmd/synesis 0.1s"),
    ];
    const out = evaluateExecutionGovernor(messages);
    // Must pause — repeated failures with no edits
    expect(out.pause).toBe(true);
    expect(["verification_churn_no_edit", "verification_fail_repeat_block"]).toContain(out.reason);
  });

  it("hasFailureSignals: exit code 1 is not suppressed by all-tests-passed output in same turn", () => {
    // When go test PASS output and a failing binary exit-code appear in the same turn,
    // hasFailureSignals should return true (i.e. the exit code is not swallowed by the
    // zero-failure bypass that would normally suppress words like "error").
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "make sure the completion feature works" },
      assistantCall("t1", "bash", { command: "go test ./..." }),
      // Contains "all tests passed"-like success output AND a binary failure in same batch
      toolResult("t1", "--- PASS: TestRunCompletion_Bash\nPASS\nok  cmd/synesis  0.1s"),
      assistantCall("b1", "bash", { command: "./synesis completion --help 2>&1" }),
      toolResult("b1", "Error: Exit code 1\nError: unsupported shell: --help"),
    ];
    // After one pass+fail turn we do not necessarily pause, but failures must be visible.
    // Run enough repetitions to trigger verification_churn_no_edit.
    for (let i = 2; i <= 5; i++) {
      messages.push(assistantCall(`t${i}`, "bash", { command: "go test ./..." }));
      messages.push(toolResult(`t${i}`, "PASS\nok  cmd/synesis  0.1s"));
      messages.push(assistantCall(`b${i}`, "bash", { command: "./synesis completion --help 2>&1" }));
      messages.push(toolResult(`b${i}`, "Error: Exit code 1\nError: unsupported shell: --help"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_churn_no_edit");
  });

  it("verbal intent streak uses a recent window and does not report inflated counts from long sessions", () => {
    // A very long session (many turns) should not cause verbal_intent_without_action
    // to report hundreds of occurrences. The window caps the streak count.
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "fix the failing test" },
    ];
    // 50+ rounds of exploration with verbal intent phrases — OUTSIDE the recency window
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "assistant", content: "I'll check the file to understand the issue." });
      messages.push(assistantCall(`r${i}`, "read_file", { path: `src/file${i % 5}.ts` }));
      messages.push(toolResult(`r${i}`, "content"));
    }
    // Then a fresh edit resets things
    messages.push(assistantCall("e1", "str_replace_based_edit_tool", { path: "src/main.ts", old_string: "a", new_string: "b" }));
    messages.push(toolResult("e1", "ok"));
    // After the edit, only 2 verbal-only messages (below streak threshold of 3)
    messages.push({ role: "assistant", content: "I'll verify the fix now." });
    messages.push({ role: "assistant", content: "Let me run the tests." });
    messages.push(assistantCall("t1", "bash", { command: "go test ./..." }));
    messages.push(toolResult("t1", "PASS"));
    const out = evaluateExecutionGovernor(messages);
    // After an edit, verbal_intent_without_action must NOT fire regardless of how long the session was
    expect(out.matchedRules).not.toContain("verbal_intent_without_action");
  });

  it("prompt-forward scoping: prior session history does not trigger behavioral rules", () => {
    // Simulates a user coming back after lunch with 80+ messages of prior history.
    // The governor should only evaluate behavior since the latest user prompt.
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [];
    // Prior session: lots of reads, searches, and even completion claims from earlier work
    messages.push({ role: "user", content: "implement the CLI features from the plan" });
    for (let i = 0; i < 30; i++) {
      messages.push(assistantCall(`old-r${i}`, "read_file", { path: `cmd/synesis/file${i % 8}.go` }));
      messages.push(toolResult(`old-r${i}`, "package main\nfunc something() {}"));
    }
    messages.push({ role: "assistant", content: "All features are already implemented." });
    // NEW prompt from the user (back from lunch)
    messages.push({ role: "user", content: "can you verify all features are complete and list what is missing?" });
    // Model does 2 reads — should NOT fire any rules yet (fresh start from prompt)
    messages.push(assistantCall("new-r1", "read_file", { path: "cmd/synesis/main.go" }));
    messages.push(toolResult("new-r1", "package main\nfunc main() {}"));
    messages.push(assistantCall("new-r2", "search", { pattern: "func run" }));
    messages.push(toolResult("new-r2", "3 matches found"));

    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(false);
    expect(out.matchedRules).toEqual(["allow"]);
  });

  it("verification_churn_no_edit fires in explore phase when failures are present", () => {
    // "make sure X works" → explore phase, but failures should still trigger churn rule
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [
      { role: "user", content: "make sure the completion feature is done and works as expected from the plan" },
    ];
    for (let i = 0; i < 5; i++) {
      messages.push(assistantCall(`t${i}`, "bash", { command: "go test ./cmd/synesis -v" }));
      messages.push(toolResult(`t${i}`, "PASS\nok cmd/synesis 0.1s"));
      messages.push(assistantCall(`b${i}`, "bash", { command: "./synesis completion --help 2>&1" }));
      messages.push(toolResult(`b${i}`, "Error: Exit code 1\nError: unsupported shell: --help (use bash or zsh)"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.pause).toBe(true);
    expect(out.matchedRules).toContain("verification_churn_no_edit");
  });

  it("treats Update alias as an edit-capable action for phase transitions", () => {
    const events: CommandEvent[] = [
      { command: "update:src/main.ts", toolName: "update", resultSignature: "ok" },
      { command: "npm test", toolName: "bash", resultSignature: "PASS" },
    ];
    const phase = detectSessionPhase(events, "finish implementation", ["src/main.ts"], false);
    expect(phase).toBe("verify");
  });

  it("captures unknown tools as opaque command events instead of dropping them", () => {
    const messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }> = [];
    for (let i = 0; i < 9; i += 1) {
      messages.push(assistantCall(`u${i}`, "MysteryTool", { command: "scan everything" }));
      messages.push(toolResult(`u${i}`, "ok"));
    }
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("no_progress_loop");
  });

  it("maps inferred governor phase to orchestration workflow phase", () => {
    const messages = [
      { role: "user", content: "Implement the fix and run tests." },
      assistantCall("p1", "Write", { file_path: "src/app.ts", content: "export const ready = true;" }),
      toolResult("p1", "File written"),
      assistantCall("p2", "Bash", { command: "npm test -- app.test.ts" }),
      toolResult("p2", "PASS app.test.ts"),
    ];
    const governorPhase = inferGovernorPhaseFromMessages(messages as never);
    expect(governorPhase).toBe("verify");
    expect(governorPhaseToWorkflowPhase(governorPhase)).toBe("validation");
  });

  it("orders multi-match rules using explicit priority model", () => {
    const messages = [
      { role: "assistant", content: "I'll verify now." },
      { role: "assistant", content: "Let me verify again." },
      { role: "assistant", content: "I'll check one more time." },
      assistantCall("r1", "Read", { file_path: "src/app.ts" }),
      toolResult("r1", "same content"),
      assistantCall("r2", "Read", { file_path: "src/app.ts" }),
      toolResult("r2", "same content"),
      assistantCall("r3", "Read", { file_path: "src/app.ts" }),
      toolResult("r3", "same content"),
      assistantCall("r4", "Read", { file_path: "src/app.ts" }),
      toolResult("r4", "same content"),
      assistantCall("r5", "Read", { file_path: "src/app.ts" }),
      toolResult("r5", "same content"),
      assistantCall("r6", "Read", { file_path: "src/app.ts" }),
      toolResult("r6", "same content"),
      assistantCall("r7", "Read", { file_path: "src/app.ts" }),
      toolResult("r7", "same content"),
      assistantCall("r8", "Read", { file_path: "src/app.ts" }),
      toolResult("r8", "same content"),
      assistantCall("r9", "Read", { file_path: "src/app.ts" }),
      toolResult("r9", "same content"),
    ];
    const out = evaluateExecutionGovernor(messages);
    expect(out.matchedRules).toContain("no_progress_loop");
    expect(out.matchedRules).toContain("verbal_intent_without_action");
    const noProgressIdx = out.matchedRules.indexOf("no_progress_loop");
    const verbalIdx = out.matchedRules.indexOf("verbal_intent_without_action");
    expect(noProgressIdx).toBeGreaterThanOrEqual(0);
    expect(verbalIdx).toBeGreaterThan(noProgressIdx);
  });
});
