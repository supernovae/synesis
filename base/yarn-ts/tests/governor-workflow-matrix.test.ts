import { describe, expect, it } from "vitest";
import { evaluateExecutionGovernor } from "../src/governance/execution-governor.js";

function assistantCall(id: string, name: string, args: unknown) {
  return { role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: args } }] };
}

function toolResult(id: string, content: string) {
  return { role: "tool", tool_call_id: id, content };
}

describe("governor workflow matrix", () => {
  it("maps core SWE lifecycle safeguards to expected governor behavior", () => {
    const matrix = [
      {
        id: "intake-first-read",
        messages: [
          { role: "user", content: "add --jq and --print-request to ask command with tests" },
          assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("1", "package main"),
        ],
        expectPause: false,
        expectPhase: "edit",
        expectIncludes: ["allow"],
      },
      {
        id: "explore-read-loop",
        messages: [
          { role: "user", content: "add --jq and --print-request to ask command with tests" },
          assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("1", "package main"),
          assistantCall("2", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("2", "Unchanged since last read"),
          assistantCall("3", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("3", "Unchanged since last read"),
        ],
        expectPause: true,
        expectPhase: "edit",
        expectIncludes: ["source_file_stale_reread"],
      },
      {
        id: "implement-write-recovery",
        messages: [
          { role: "user", content: "continue implementing ask.go changes now" },
          assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("1", "package main"),
          assistantCall("2", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("2", "Unchanged since last read"),
          assistantCall("3", "Write", { file_path: "cmd/synesis/ask.go", content: "package main\n// updated\n" }),
          toolResult("3", "Updated cmd/synesis/ask.go successfully"),
          assistantCall("4", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("4", "package main\n// updated"),
          assistantCall("5", "read_file", { path: "cmd/synesis/ask.go" }),
          toolResult("5", "Unchanged since last read"),
        ],
        expectPause: false,
        expectPhase: "edit",
        expectExcludes: ["source_file_stale_reread"],
      },
      {
        id: "verify-dep-install-replay",
        messages: [
          { role: "user", content: "fix build dependencies and continue" },
          assistantCall("1", "bash", { command: "npm install" }),
          toolResult("1", "up to date"),
          assistantCall("2", "bash", { command: "npm install" }),
          toolResult("2", "up to date"),
        ],
        expectPause: true,
        expectPhase: "edit",
        expectIncludes: ["dependency_install_replay"],
      },
      {
        id: "finalize-commit-followthrough",
        messages: [
          { role: "user", content: "finish and commit your implementation" },
          assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "x", new_string: "y" }),
          toolResult("1", "Applied edit"),
          assistantCall("2", "bash", { command: "git add -A" }),
          toolResult("2", ""),
          assistantCall("3", "bash", { command: "git status --short" }),
          toolResult("3", "M cmd/synesis/ask.go"),
          assistantCall("4", "bash", { command: "git diff --stat HEAD" }),
          toolResult("4", " cmd/synesis/ask.go | 2 +-"),
        ],
        expectPause: false,
        expectPhase: "edit",
        expectReason: "git_commit_followthrough",
        expectIncludes: ["git_commit_followthrough"],
      },
    ] as const;

    for (const row of matrix) {
      const out = evaluateExecutionGovernor(row.messages as never);
      expect(out.pause, row.id).toBe(row.expectPause);
      expect(out.telemetry.phase, row.id).toBe(row.expectPhase);
      if (row.expectReason) expect(out.reason, row.id).toBe(row.expectReason);
      if (row.expectIncludes) {
        for (const rule of row.expectIncludes) {
          expect(out.matchedRules, `${row.id}:${rule}`).toContain(rule);
        }
      }
      if (row.expectExcludes) {
        for (const rule of row.expectExcludes) {
          expect(out.matchedRules, `${row.id}:${rule}`).not.toContain(rule);
        }
      }
    }
  });

  it("enforces completion-claim gates by active plan stage", () => {
    const messages = [
      { role: "user", content: "implement clipboard support" },
      { role: "assistant", content: "I've completed the clipboard support implementation." },
      assistantCall("1", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "x", new_string: "y" }),
      toolResult("1", "Applied edit"),
    ];

    const implementStage = evaluateExecutionGovernor(messages as never, { activePlanStage: "implement" });
    expect(implementStage.pause).toBe(true);
    expect(implementStage.reason).toBe("completion_claim_requires_task_update");

    const finalizeStage = evaluateExecutionGovernor(messages as never, { activePlanStage: "finalize" });
    expect(finalizeStage.matchedRules).not.toContain("completion_claim_requires_task_update");
  });

  it("keeps repair flow active for completion-claim + stale-read + edit-miss collisions", () => {
    const messages = [
      { role: "user", content: "verify and finish ask.go updates" },
      { role: "assistant", content: "This is already implemented." },
      assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("1", "package main"),
      assistantCall("2", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("2", "Unchanged since last read"),
      assistantCall("3", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "model := fs.String", new_string: "model := fs.String" }),
      toolResult("3", "Error editing file: old_string not found"),
      assistantCall("4", "str_replace", { file_path: "cmd/synesis/ask.go", old_string: "model := fs.String", new_string: "model := fs.String" }),
      toolResult("4", "Error editing file: old_string not found"),
    ];
    const out = evaluateExecutionGovernor(messages as never, { activePlanStage: "implement" });
    expect(out.telemetry.phase).toBe("edit");
    expect(out.matchedRules).toContain("edit_failure_replay");
    expect(out.matchedRules).not.toContain("completion_claim_requires_task_update");
  });

  it("captures repeated 'String to replace not found' misses as edit replay", () => {
    const messages = [
      { role: "user", content: "finish ask.go if anything is missing" },
      assistantCall("1", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("1", "package main"),
      assistantCall("2", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      toolResult("2", "Error: String to replace not found in file."),
      assistantCall("3", "read_file", { path: "cmd/synesis/ask.go" }),
      toolResult("3", "Unchanged since last read"),
      assistantCall("4", "Edit", { file_path: "cmd/synesis/ask.go", old_string: "jqExpr := fs.String", new_string: "jqExpr := fs.String" }),
      toolResult("4", "Error: String to replace not found in file."),
    ];
    const out = evaluateExecutionGovernor(messages as never, { activePlanStage: "implement" });
    expect(out.matchedRules).toContain("edit_failure_replay");
  });
});
