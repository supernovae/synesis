import path from "node:path";
import { describe, expect, it } from "vitest";
import { governToolCall } from "../src/path-governance/tool-call-governance.js";

describe("governToolCall", () => {
  it("normalizes duplicate leading file segments", () => {
    const out = governToolCall({
      toolName: "Read",
      input: { file_path: "repo/repo/main.go" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.input.file_path).toBe("repo/main.go");
    expect(out.normalizedPath).toBe(true);
  });

  it("clamps outside-root traversal to basename", () => {
    const out = governToolCall({
      toolName: "Read",
      input: { file_path: "../../etc/passwd" },
      projectRoot: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.input.file_path).toBe("passwd");
    expect(out.constrainedToRoot).toBe(true);
  });

  it("uses shell_cwd as anchor when project_root missing", () => {
    const out = governToolCall({
      toolName: "Write",
      input: { file_path: "/tmp/outside.go", content: "package main" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.input.file_path).toBe("outside.go");
    expect(out.constrainedToRoot).toBe(true);
  });

  it("blocks dangerous rm -rf shell command", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "rm -rf Users" },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.blockedBashDrift).toBe(true);
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
    expect(out.blockedBashDrift).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("unsafe_shell");
    expect(out.input.retryable).toBe(true);
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
    expect(out.blockedBashDrift).toBe(true);
    expect(out.input.synesis_error).toBe(true);
    expect(out.input.reason).toBe("write_capable_blocked");
    expect(out.input.original_tool).toBe("Write");
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

  it("recovers absolute out-of-root Edit path to candidate Glob lookup", () => {
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
    expect(out.toolName).toBe("Glob");
    expect(out.input).toEqual({ glob_pattern: "**/vector_store.py" });
  });

  it("keeps governed file paths inside project root across mixed path styles", () => {
    const root = "/Users/me/repo";
    const cases = [
      "main.go",
      "./pkg/main.go",
      "repo/repo/main.go",
      "../../etc/passwd",
      "/Users/me/repo/cmd/app.go",
      "Users/me/repo/cmd/app.go",
      "/tmp/outside.go",
      "C:/Users/dev/secret.go",
      "C:\\Users\\dev\\secret.go",
    ];
    for (const filePath of cases) {
      const out = governToolCall({
        toolName: "Write",
        input: { file_path: filePath, content: "package main" },
        projectRoot: root,
        enforcePathRoot: true,
        blockBashPathDrift: true,
      });
      const governedPath = String(out.input.file_path ?? "");
      // Invariant: governed file path is never absolute and cannot traverse upward.
      expect(path.isAbsolute(governedPath)).toBe(false);
      expect(governedPath.includes("..")).toBe(false);
    }
  });
});
