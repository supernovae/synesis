import path from "node:path";
import { describe, expect, it } from "vitest";
import { governToolCall } from "../src/path-governance/tool-call-governance.js";
import { buildDefaultPolicy } from "../src/path-governance/path-sandbox.js";

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

  it("repairs project-relative file paths that duplicate shell_cwd", () => {
    const out = governToolCall({
      toolName: "Read",
      input: { file_path: "k8/overseerr/overseerr-k8s.yaml" },
      projectRoot: "/home/byron",
      shellCwd: "/home/byron/k8/overseerr",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.input.file_path).toBe("overseerr-k8s.yaml");
    expect(out.normalizedPath).toBe(true);
  });

  it("repairs opencode cwd-prefixed camelCase file paths before returning to the client", () => {
    const out = governToolCall({
      toolName: "Read",
      input: { filePath: "k8/overseerr/overseerr-k8s.yaml" },
      projectRoot: "/home/byron/k8",
      shellCwd: "/home/byron/k8/overseerr",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
    });
    expect(out.input.filePath).toBe("overseerr-k8s.yaml");
    expect(out.normalizedPath).toBe(true);
  });

  it("repairs paths that repeat a suffix of shell_cwd without project_root", () => {
    const out = governToolCall({
      toolName: "Read",
      input: { file_path: "k8/overseerr/overseerr-k8s.yaml" },
      shellCwd: "/home/byron/k8/overseerr",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.input.file_path).toBe("overseerr-k8s.yaml");
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

  it.each([
    { clientKind: "claude-code", expectedTool: "Synesis_Error_UnsafeShell", expectsSynthetic: true },
    { clientKind: "cursor", expectedTool: "Bash", expectsSynthetic: false },
    { clientKind: "roo", expectedTool: "Bash", expectsSynthetic: false },
    { clientKind: "opencode", expectedTool: "Bash", expectsSynthetic: false },
  ])(
    "client matrix applies deterministic unsafe-shell handling for $clientKind",
    ({ clientKind, expectedTool, expectsSynthetic }) => {
      const out = governToolCall({
        toolName: "Bash",
        input: { command: "rm -rf /tmp/test" },
        shellCwd: "/Users/me/repo",
        enforcePathRoot: true,
        blockBashPathDrift: true,
        clientKind,
      });
      expect(out.toolName).toBe(expectedTool);
      expect(out.blockedUnsafeShell).toBe(true);
      if (expectsSynthetic) {
        expect(out.input.synesis_error).toBe(true);
      } else {
        expect(String(out.input.command)).toContain("unsafe_shell");
      }
    },
  );

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

  it("allows first compound git inspection as grace for orientation", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "git status && git diff pkg/output/output.go" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      sessionGitInspectionBlockCount: 0,
    });
    expect(out.toolName).toBe("Bash");
    expect(out.blockedUnsafeShell).toBe(false);
  });

  it("blocks compound git inspection churn after grace for claude-code", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "git status && git diff pkg/output/output.go" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      sessionGitInspectionBlockCount: 1,
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

  it("allows native Agent tool for claude-code sessions", () => {
    const out = governToolCall({
      toolName: "Agent",
      input: { description: "Explore recent commits", prompt: "Explore codebase" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Agent");
    expect(out.input).toEqual({ description: "Explore recent commits", prompt: "Explore codebase" });
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

  it("blocks opencode Glob patterns that target a parent workspace directory", () => {
    const out = governToolCall({
      toolName: "glob",
      input: { pattern: "/home/byron/src/*" },
      projectRoot: "/home/byron/src/test",
      shellCwd: "/home/byron/src/test",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
      pathSandboxPolicy: buildDefaultPolicy("/home/byron/src/test"),
    });
    expect(out.toolName).toBe("Bash");
    expect(out.blockedPathSandbox).toBe(true);
    expect(String(out.input.command)).toContain("path_sandbox_violation");
    expect(String(out.input.command)).toContain("/home/byron/src");
  });

  it("blocks Bash parent-directory discovery from an empty opencode workspace", () => {
    for (const command of [
      "ls -la ..",
      "find .. -name \"categorizer.py\" -o -name \"main.py\"",
      "cd /home/byron/src && mkdir -p taskpulse",
    ]) {
      const out = governToolCall({
        toolName: "Bash",
        input: { command },
        projectRoot: "/home/byron/src/test",
        shellCwd: "/home/byron/src/test",
        enforcePathRoot: true,
        blockBashPathDrift: true,
        clientKind: "opencode",
        pathSandboxPolicy: buildDefaultPolicy("/home/byron/src/test"),
      });
      expect(out.toolName).toBe("Bash");
      expect(out.blockedPathSandbox).toBe(true);
      expect(String(out.input.command)).toContain("path_sandbox_violation");
    }
  });

  it("allows scoped opencode Glob patterns inside the project root", () => {
    const out = governToolCall({
      toolName: "glob",
      input: { pattern: "taskpulse/**/*.py" },
      projectRoot: "/home/byron/src/test",
      shellCwd: "/home/byron/src/test",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
      pathSandboxPolicy: buildDefaultPolicy("/home/byron/src/test"),
    });
    expect(out.toolName).toBe("glob");
    expect(out.blockedPathSandbox).toBeUndefined();
  });

  it("blocks Grep target directories outside the project root", () => {
    const out = governToolCall({
      toolName: "grep",
      input: { pattern: "categorizer", path: "/home/byron/src" },
      projectRoot: "/home/byron/src/test",
      shellCwd: "/home/byron/src/test",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
      pathSandboxPolicy: buildDefaultPolicy("/home/byron/src/test"),
    });
    expect(out.blockedPathSandbox).toBe(true);
    expect(String(out.input.command)).toContain("path_sandbox_violation");
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

  it("blocks repeated failing verification bash when fail-repeat guard is active", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "go test -c ./cmd/synesis 2>&1" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      blockVerificationForFailure: true,
    });
    expect(out.toolName).toBe("Synesis_Error_VerificationLoop");
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("verification_fail_repeat_block");
  });

  it("allows verification bash when fail-repeat guard is inactive", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "go test -c ./cmd/synesis 2>&1" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      blockVerificationForFailure: false,
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

  it("blocks stub phrase overwrite for Claude plan files (Write)", () => {
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
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("plan_write_blocked");
    expect(out.input.original_tool).toBe("Write");
    expect(out.planWriteAudit?.allowed).toBe(false);
    expect(out.planWriteAudit?.reason).toContain("contains_stub_phrase");
  });

  it("blocks stub phrase overwrite for Claude plan files (Edit)", () => {
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
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.input.reason).toBe("plan_write_blocked");
    expect(out.input.original_tool).toBe("Edit");
  });

  it("blocks 'unchanged since last read' stub writes to plan files", () => {
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: "Unchanged since last read",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.planWriteAudit?.reason).toContain("unchanged since last read");
  });

  it("blocks FILE_UNCHANGED stub writes to plan files", () => {
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: '<FILE_UNCHANGED path="main.go" />',
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.planWriteAudit?.reason).toContain("<file_unchanged");
  });

  it("blocks plan Write missing YAML frontmatter", () => {
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
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.planWriteAudit?.reason).toContain("missing_yaml_frontmatter");
  });

  it("allows valid plan Write with YAML frontmatter", () => {
    const validContent = [
      "---",
      "name: My Plan",
      "todos:",
      "  - id: task1",
      "    content: Do something",
      "    status: pending",
      "---",
      "",
      "# My Plan",
      "Details here...",
    ].join("\n");
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: validContent,
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Write");
    expect(out.blockedWriteCapable).toBe(false);
    expect(out.planWriteAudit?.allowed).toBe(true);
  });

  it("allows partial Edit to plan files (no frontmatter required)", () => {
    const out = governToolCall({
      toolName: "Edit",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        old_string: "    status: pending",
        new_string: "    status: completed",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Edit");
    expect(out.blockedWriteCapable).toBe(false);
    expect(out.planWriteAudit?.allowed).toBe(true);
  });

  it("blocks plan Write with size regression vs shadow", () => {
    const shadow = {
      path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
      contentHash: "abc123",
      contentLength: 1000,
      todos: [],
      lastReadAt: Date.now(),
    };
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: "---\nname: Tiny Plan\ntodos: []\n---\n# Tiny\n",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      planContentShadow: shadow,
    });
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.planWriteAudit?.reason).toContain("size_regression");
  });

  it("blocks plan Write with monotonicity violation", () => {
    const shadow = {
      path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
      contentHash: "abc123",
      contentLength: 200,
      todos: [
        { id: "task1", content: "Do X", status: "completed" as const },
        { id: "task2", content: "Do Y", status: "in_progress" as const },
      ],
      lastReadAt: Date.now(),
    };
    const regressedContent = [
      "---",
      "name: My Plan",
      "todos:",
      "  - id: task1",
      "    content: Do X",
      "    status: pending",
      "  - id: task2",
      "    content: Do Y",
      "    status: in_progress",
      "---",
      "",
      "# Plan body",
    ].join("\n");
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: regressedContent,
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      planContentShadow: shadow,
    });
    expect(out.toolName).toBe("Synesis_Error_PlanWriteBlocked");
    expect(out.planWriteAudit?.reason).toContain("monotonicity_violation");
    expect(out.planWriteAudit?.reason).toContain("task1");
    expect(out.planWriteAudit?.reason).toContain("completed->pending");
  });

  it("allows forward status transitions in plan writes", () => {
    const shadow = {
      path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
      contentHash: "abc123",
      contentLength: 200,
      todos: [
        { id: "task1", content: "Do X", status: "pending" as const },
        { id: "task2", content: "Do Y", status: "in_progress" as const },
      ],
      lastReadAt: Date.now(),
    };
    const advancedContent = [
      "---",
      "name: My Plan",
      "todos:",
      "  - id: task1",
      "    content: Do X",
      "    status: in_progress",
      "  - id: task2",
      "    content: Do Y",
      "    status: completed",
      "---",
      "",
      "# Plan body",
    ].join("\n");
    const out = governToolCall({
      toolName: "Write",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        content: advancedContent,
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
      planContentShadow: shadow,
    });
    expect(out.toolName).toBe("Write");
    expect(out.planWriteAudit?.allowed).toBe(true);
  });

  it("detects and blocks plan writes via Bash heredoc", () => {
    const command = `cat > /Users/bymiller/.claude/plans/steady-splashing-peach.md <<'EOF'\nUnchanged since last read\nEOF`;
    const out = governToolCall({
      toolName: "Bash",
      input: { command },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.blockedWriteCapable).toBe(true);
    expect(out.planWriteAudit?.allowed).toBe(false);
    expect(out.planWriteAudit?.reason).toContain("unchanged since last read");
  });

  it("emits user-safe validation failure text for non-claude clients", () => {
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
    expect(cmd).toContain("Tool call blocked: invalid arguments for Write");
    expect(cmd).toContain("missing: content");
    expect(cmd).not.toContain("\"synesis_error\":true");
  });

  it("normalizes OpenCode-style Write aliases before validation", () => {
    const out = governToolCall({
      toolName: "write_file",
      input: { path: "requirements.txt", contents: "fastapi\nuvicorn\n" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
    });
    expect(out.toolName).toBe("write_file");
    expect(out.validationMissing).toEqual([]);
    expect(out.input).toEqual({ file_path: "requirements.txt", content: "fastapi\nuvicorn\n" });
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

  it("unwraps and normalizes aliased envelope args for Write", () => {
    const out = governToolCall({
      toolName: "write_file",
      input: { args: { path: "pyproject.toml", file_text: "[project]\n" } },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "opencode",
    });
    expect(out.toolName).toBe("write_file");
    expect(out.validationMissing).toEqual([]);
    expect(out.input).toEqual({ file_path: "pyproject.toml", content: "[project]\n" });
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

  it("does not auto-recover plan-file Edit missing old_string to Read", () => {
    const out = governToolCall({
      toolName: "Edit",
      input: {
        file_path: "/Users/bymiller/.claude/plans/steady-splashing-peach.md",
        new_string: "- [x] Phase 4 complete",
      },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      clientKind: "claude-code",
    });
    expect(out.toolName).toBe("Synesis_Error_ValidationFailed");
    expect(out.validationMissing).toContain("old_string");
    expect(out.input.reason).toBe("validation_failed");
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
      { path: "../../etc/passwd", content: "package main" },
      { path: "/tmp/outside.go", content: "package main" },
      { path: "/Users/someone/.claude/plans/plan.md", content: "---\nname: Plan\ntodos:\n  - id: t1\n    content: test\n    status: pending\n---\n# Plan\n" },
    ];
    for (const { path: filePath, content } of passThrough) {
      const out = governToolCall({
        toolName: "Write",
        input: { file_path: filePath, content },
        projectRoot: root,
        enforcePathRoot: true,
        blockBashPathDrift: true,
      });
      expect(out.constrainedToRoot).toBe(false);
      expect(out.input.file_path).toBe(filePath);
    }
  });
});
