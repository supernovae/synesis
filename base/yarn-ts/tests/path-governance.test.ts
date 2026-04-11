import path from "node:path";
import { describe, expect, it } from "vitest";
import { governToolCall } from "../src/path-governance/tool-call-governance.js";

describe("governToolCall", () => {
  it("normalizes duplicate leading file segments for write tools", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "repo/repo/main.go", content: "package main" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.input.file_path).toBe("repo/main.go");
    expect(out.normalizedPath).toBe(true);
  });

  it("passes through out-of-root paths to the client (client enforces permissions)", () => {
    const traversal = governToolCall({
      toolName: "Write",
      input: { file_path: "../../etc/passwd", content: "hacked" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(traversal.constrainedToRoot).toBe(false);
    expect(traversal.input.file_path).toBe("../../etc/passwd");

    const absolute = governToolCall({
      toolName: "Edit",
      input: { file_path: "/Users/bymiller/.claude/plans/steady-mixing-dewdrop.md", old_string: "- [ ]", new_string: "- [x]" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(absolute.constrainedToRoot).toBe(false);
    expect(absolute.input.file_path).toBe("/Users/bymiller/.claude/plans/steady-mixing-dewdrop.md");
  });

  it("passes through out-of-root paths when shell_cwd is anchor", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "/tmp/outside.go", content: "package main" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.constrainedToRoot).toBe(false);
    expect(out.input.file_path).toBe("/tmp/outside.go");
  });

  it("blocks dangerous rm -rf shell command", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "rm -rf Users" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.blockedUnsafeShell).toBe(true);
    expect(out.blockedBashDrift).toBe(false);
    expect(String(out.input.command)).toContain("unsafe_shell");
  });

  it("rewrites blocked unsafe shell to synthetic error tool for claude-code", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_UnsafeShell");
    expect(out.blockedUnsafeShell).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("unsafe_shell");
    expect(out.input.retryable).toBe(true);
  });

  it("blocks mkdir/cd duplicate segment path drift", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "mkdir -p demo && cd demo" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.blockedBashDrift).toBe(true);
    expect(out.blockedUnsafeShell).toBe(true);
    expect(String(out.input.command)).toContain("path drift");
  });

  it("blocks compound git inspection churn for claude-code", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "git status && git diff pkg/output/output.go" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_GitInspectionChurn");
    expect(out.blockedUnsafeShell).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("git_inspection_churn");
  });

  it("allows git commands that include concrete action", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "git add pkg/output/output.go && git commit -m \"update output\"" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Bash");
    expect(out.blockedUnsafeShell).toBe(false);
  });

  it("blocks Agent subagent exploration for claude-code sessions", () => {
    const out = governToolCall({
      toolName: "Agent",
      input: { description: "Explore recent commits", prompt: "Explore codebase" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_SubagentBlocked");
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("subagent_exploration_blocked");
  });

  it("does not block Agent tool for non-claude clients", () => {
    const out = governToolCall({
      toolName: "Agent",
      input: { description: "Explore recent commits", prompt: "Explore codebase" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "cursor",
    });
    expect(out.toolName).toBe("Agent");
  });

  it("blocks broad Glob discovery in plan-execution mode for claude-code", () => {
    const out = governToolCall({
      toolName: "Glob",
      input: { glob_pattern: "**/*.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      restrictDiscoveryForPlanWork: true,
    });
    expect(out.toolName).toBe("Synesis_Error_PlanExecutionScope");
    expect(out.blockedUnsafeShell).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("plan_execution_scope");
  });

  it("allows narrow Glob in plan-execution mode", () => {
    const out = governToolCall({
      toolName: "Glob",
      input: { glob_pattern: "base/yarn-ts/src/providers/*.ts" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      restrictDiscoveryForPlanWork: true,
    });
    expect(out.toolName).toBe("Glob");
  });

  it("blocks git-status churn bash in plan-execution mode", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "git status && git log --oneline -5" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      restrictDiscoveryForPlanWork: true,
    });
    expect(out.toolName).toBe("Synesis_Error_PlanExecutionScope");
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("plan_execution_scope");
  });

  it("blocks broad verification bash when green-repeat guard is active", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "go test ./... && go build ./..." },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      blockBroadVerificationForGreen: true,
    });
    expect(out.toolName).toBe("Synesis_Error_VerificationLoop");
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("verification_green_repeat_block");
  });

  it("allows broad verification bash when green-repeat guard is inactive", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "go test ./... && go build ./..." },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      blockBroadVerificationForGreen: false,
    });
    expect(out.toolName).toBe("Bash");
  });

  it("normalizes alias tool names for validation without renaming output tool", () => {
    const out = governToolCall({
      toolName: "read_file",
      input: { file_path: "repo/repo/main.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.toolName).toBe("read_file");
    expect(out.normalizedPath).toBe(true);
  });

  it("blocks write-capable tools when strict profile is enabled", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "main.go", content: "package main" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      blockWriteCapableTools: true,
    });
    expect(out.toolName).toBe("Bash");
    expect(out.blockedWriteCapable).toBe(true);
    expect(String(out.input.command)).toContain("write_capable_blocked");
    expect(String(out.input.command)).toContain("blocked write-capable tool");
  });

  it("rewrites blocked write-capable tool to synthetic error tool for claude-code", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "main.go", content: "package main" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      blockWriteCapableTools: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_WriteCapableBlocked");
    expect(out.blockedBashDrift).toBe(false);
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("write_capable_blocked");
    expect(out.input.original_tool).toBe("Write");
  });

  it("blocks destructive placeholder overwrite for Claude plan files (Write)", () => {
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: "No plan file exists yet. This is a fresh session.\n",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_PlanPlaceholderBlocked");
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("plan_placeholder_blocked");
    expect(out.input.original_tool).toBe("Write");
  });

  it("blocks destructive placeholder overwrite for Claude plan files (Edit)", () => {
    const out = governToolCall({
      toolName: "Edit",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        old_string: "# Existing plan",
        new_string: "No plan file exists yet. This is a fresh session.\n",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_PlanPlaceholderBlocked");
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.input.reason).toBe("plan_placeholder_blocked");
    expect(out.input.original_tool).toBe("Edit");
  });

  it("allows normal writes to Claude plan files", () => {
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: "# Working Plan\n- [ ] task A\n",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Write");
    expect(out.blockedWriteCapable).toBe(false);
  });

  it("emits structured JSON for Write validation failure", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "main.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.toolName).toBe("Bash");
    expect(out.validationMissing).toContain("content");
    const cmd = String(out.input.command);
    expect(cmd).toContain("printf");
    expect(cmd).toContain('"category":"validation"');
    expect(cmd).toContain('"original_tool":"Write"');
    expect(cmd).toContain("missing");
  });

  it("rewrites validation failure to synthetic error tool for claude-code", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "main.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_ValidationFailed");
    expect(out.validationMissing).toContain("content");
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("validation_failed");
    expect(out.input.original_tool).toBe("Write");
  });

  it("unwraps strict-schema envelope args for Write", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { tool: "Write", args: { file_path: "main.go", content: "package main" } },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Write");
    expect(out.validationMissing).toEqual([]);
    expect(out.input).toEqual({ file_path: "main.go", content: "package main" });
    expect(out.envelopeUnwrapped).toBe(true);
    expect(out.envelopeSource).toBe("args_object");
  });

  it("unwraps JSON-string arguments envelope for Bash", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { arguments: "{\"command\":\"git status\"}" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Bash");
    expect(out.validationMissing).toEqual([]);
    expect(out.input).toEqual({ command: "git status" });
    expect(out.envelopeUnwrapped).toBe(true);
    expect(out.envelopeSource).toBe("arguments_json_string");
  });

  it("includes expected schema and example on validation failures", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "main.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_ValidationFailed");
    expect(out.input.expected_schema).toEqual(["file_path", "content"]);
    expect(out.input.example).toEqual({ file_path: "path/to/file.ts", content: "..." });
  });

  it("recovers Edit missing old_string to a safe Read call", () => {
    const out = governToolCall({
      toolName: "Edit",
      input: { file_path: "main.go", new_string: "package main" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.toolName).toBe("Read");
    expect(out.input).toEqual({ file_path: "main.go" });
    expect(out.validationMissing).toEqual([]);
  });

  it("recovers Glob missing glob_pattern to a safe default pattern", () => {
    const out = governToolCall({
      toolName: "Glob",
      input: {},
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.toolName).toBe("Glob");
    expect(out.input).toEqual({ glob_pattern: "*" });
    expect(out.validationMissing).toEqual([]);
  });

  it("passes through absolute out-of-root Edit path to client", () => {
    const out = governToolCall({
      toolName: "Edit",
      input: {
        file_path: "/Users/someone/other-project/src/vector_store.py",
        old_string: "x = 1",
        new_string: "x = 2",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.toolName).toBe("Edit");
    expect(out.constrainedToRoot).toBe(false);
    expect(out.input.file_path).toBe("/Users/someone/other-project/src/vector_store.py");
  });

  it("clamps hallucinated paths but passes through legitimate ones", () => {
    const root = "/Users/me/repo";

    const hallucinated: Array<[string, string]> = [
      ["C:/Users/dev/secret.go", "secret.go"],
      ["C:\\Users\\dev\\secret.go", "secret.go"],
    ];
    for (const [filePath, expected] of hallucinated) {
      const out = governToolCall({
        toolName: "Write",
        input: { file_path: filePath, content: "package main" },
        projectRoot: root,
        enforcePathRoot: true,
        blockBashPathDrift: true,
      });
      expect(out.constrainedToRoot).toBe(true);
      expect(out.input.file_path).toBe(expected);
    }

    const inRoot: Array<[string, string]> = [
      ["main.go", "main.go"],
      ["/Users/me/repo/cmd/app.go", "cmd/app.go"],
      ["Users/me/repo/cmd/app.go", "cmd/app.go"],
    ];
    for (const [filePath, expected] of inRoot) {
      const out = governToolCall({
        toolName: "Write",
        input: { file_path: filePath, content: "package main" },
        projectRoot: root,
        enforcePathRoot: true,
        blockBashPathDrift: true,
      });
      const governedPath = String(out.input.file_path ?? "");
      expect(path.isAbsolute(governedPath)).toBe(false);
      expect(governedPath).toBe(expected);
    }

    const passThrough = [
      "../../etc/passwd",
      "/tmp/outside.go",
      "/Users/someone/.claude/plans/plan.md",
    ];
    for (const filePath of passThrough) {
      const out = governToolCall({
        toolName: "Write",
        input: { file_path: filePath, content: "package main" },
        projectRoot: root,
        enforcePathRoot: true,
        blockBashPathDrift: true,
      });
      expect(out.constrainedToRoot).toBe(false);
      expect(out.input.file_path).toBe(filePath);
    }
  });
});
