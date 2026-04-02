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
    expect(out.input.file_path).toBe("tmp/outside.go");
    expect(out.constrainedToRoot).toBe(false);
  });

  it("blocks mkdir&&cd duplicate-segment drift", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "mkdir -p aws-cost-calculator && cd aws-cost-calculator" },
      shellCwd: "/Users/me/aws-cost-calculator",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.blockedBashDrift).toBe(true);
    expect(String(out.input.command)).toContain("blocked risky shell path drift");
  });

  it("does not block benign bash command", () => {
    const out = governToolCall({
      toolName: "Bash",
      input: { command: "go build ./..." },
      shellCwd: "/Users/me/repo",
      enforcePathRoot: true,
      blockBashPathDrift: true,
    });
    expect(out.blockedBashDrift).toBe(false);
    expect(out.validationMissing).toEqual([]);
  });
});
