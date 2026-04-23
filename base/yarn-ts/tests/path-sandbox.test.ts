import { describe, expect, it } from "vitest";
import {
  evaluatePathAccess,
  buildDefaultPolicy,
  extractBashFilePaths,
  projectTmpDir,
} from "../src/path-governance/path-sandbox.js";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const PROJECT = path.join(HOME, "src/myproject");

function policy() {
  return buildDefaultPolicy(PROJECT);
}

describe("path-sandbox", () => {
  describe("project root access", () => {
    it("allows read within project root", () => {
      const result = evaluatePathAccess("src/main.ts", "read", policy());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("project_root");
    });

    it("allows write within project root", () => {
      const result = evaluatePathAccess("src/main.ts", "write", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows absolute path within project root", () => {
      const result = evaluatePathAccess(path.join(PROJECT, "lib/util.ts"), "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows project root itself", () => {
      const result = evaluatePathAccess(PROJECT, "read", policy());
      expect(result.allowed).toBe(true);
    });
  });

  describe("~/.claude access", () => {
    it("allows reading ~/.claude/plans/my-plan.md", () => {
      const result = evaluatePathAccess("~/.claude/plans/my-plan.md", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows writing ~/.claude/plans/my-plan.md", () => {
      const result = evaluatePathAccess("~/.claude/plans/my-plan.md", "write", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.claude/CLAUDE.md", () => {
      const result = evaluatePathAccess("~/.claude/CLAUDE.md", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows writing ~/.claude/settings.json", () => {
      const result = evaluatePathAccess("~/.claude/settings.json", "write", policy());
      expect(result.allowed).toBe(true);
    });

    it("blocks writing to ~/.claude root (not in write allowlist)", () => {
      const result = evaluatePathAccess("~/.claude/random-file.txt", "write", policy());
      expect(result.allowed).toBe(false);
    });
  });

  describe("cross-project agent config blocking", () => {
    it("blocks CLAUDE.md from another project", () => {
      const otherProject = path.join(HOME, "src/other-project/CLAUDE.md");
      const result = evaluatePathAccess(otherProject, "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cross_project_agent_config");
      expect(result.nudge).toContain("blocked for safety");
    });

    it("blocks .cursorrules from another project", () => {
      const otherProject = path.join(HOME, "src/other-project/.cursorrules");
      const result = evaluatePathAccess(otherProject, "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cross_project_agent_config");
    });

    it("blocks AGENTS.md from parent directory", () => {
      const parent = path.join(HOME, "src/AGENTS.md");
      const result = evaluatePathAccess(parent, "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cross_project_agent_config");
    });

    it("allows CLAUDE.md within project root", () => {
      const result = evaluatePathAccess(path.join(PROJECT, "CLAUDE.md"), "read", policy());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("project_root");
    });

    it("allows CLAUDE.md within ~/.claude", () => {
      const result = evaluatePathAccess("~/.claude/CLAUDE.md", "read", policy());
      expect(result.allowed).toBe(true);
    });
  });

  describe("system path blocking", () => {
    it("blocks /etc/passwd", () => {
      const result = evaluatePathAccess("/etc/passwd", "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked_system_path");
    });

    it("blocks /usr/bin/node", () => {
      const result = evaluatePathAccess("/usr/bin/node", "read", policy());
      expect(result.allowed).toBe(false);
    });

    it("blocks /var/log/system.log", () => {
      const result = evaluatePathAccess("/var/log/system.log", "read", policy());
      expect(result.allowed).toBe(false);
    });

    it("blocks /proc/self/environ", () => {
      const result = evaluatePathAccess("/proc/self/environ", "read", policy());
      expect(result.allowed).toBe(false);
    });
  });

  describe("/tmp access with project-scoped nudge", () => {
    it("allows reading /tmp files", () => {
      const result = evaluatePathAccess("/tmp/build-output.log", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows writing /tmp files", () => {
      const result = evaluatePathAccess("/tmp/scratch.txt", "write", policy());
      expect(result.allowed).toBe(true);
    });

    it("nudges toward project-scoped /tmp subdir for unscoped paths", () => {
      const result = evaluatePathAccess("/tmp/scratch.txt", "write", policy());
      expect(result.allowed).toBe(true);
      expect(result.nudge).toContain("/tmp/myproject");
      expect(result.nudge).toContain("Prefer using");
    });

    it("does not nudge when already in project-scoped /tmp subdir", () => {
      const scoped = projectTmpDir(PROJECT);
      const result = evaluatePathAccess(`${scoped}/output.log`, "write", policy());
      expect(result.allowed).toBe(true);
      expect(result.nudge).toBeUndefined();
    });

    it("projectTmpDir derives name from project root basename", () => {
      expect(projectTmpDir("/Users/me/src/cool-app")).toBe("/tmp/cool-app");
      expect(projectTmpDir("/home/dev/synesis")).toBe("/tmp/synesis");
    });
  });

  describe("path traversal", () => {
    it("blocks ../../etc/passwd (resolved outside root)", () => {
      const result = evaluatePathAccess("../../etc/passwd", "read", policy());
      expect(result.allowed).toBe(false);
    });

    it("blocks absolute path to another user's home", () => {
      const result = evaluatePathAccess("/Users/otheruser/secrets.txt", "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("other_user_home");
    });
  });

  describe("harness config directory reads", () => {
    it("allows reading ~/.cursor/rules/my-rule.mdc", () => {
      const result = evaluatePathAccess("~/.cursor/rules/my-rule.mdc", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.vscode/settings.json", () => {
      const result = evaluatePathAccess("~/.vscode/settings.json", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.gemini/settings.json", () => {
      const result = evaluatePathAccess("~/.gemini/settings.json", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.codex/config.toml", () => {
      const result = evaluatePathAccess("~/.codex/config.toml", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.codeium/windsurf/global_rules.md", () => {
      const result = evaluatePathAccess("~/.codeium/windsurf/global_rules.md", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows reading ~/.aider/history", () => {
      const result = evaluatePathAccess("~/.aider/history", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("blocks writing to ~/.cursor (no write allowlist)", () => {
      const result = evaluatePathAccess("~/.cursor/settings.json", "write", policy());
      expect(result.allowed).toBe(false);
    });

    it("allows writing to ~/.gemini/tmp/ (Gemini tool temp)", () => {
      const result = evaluatePathAccess("~/.gemini/tmp/tool-output.json", "write", policy());
      expect(result.allowed).toBe(true);
    });
  });

  describe("macOS $TMPDIR carve-out", () => {
    it("allows $TMPDIR path even though it is under /private/var", () => {
      // Simulate macOS TMPDIR: /private/var/folders/xx/yy/T/
      const p = policy();
      // Manually add the TMPDIR glob to simulate what resolveSessionTmpDir does
      const macTmpDir = "/private/var/folders/ab/cd1234/T";
      p.allowedReadGlobs.push(`${macTmpDir}/**`);
      p.allowedWriteGlobs.push(`${macTmpDir}/**`);
      const result = evaluatePathAccess(`${macTmpDir}/session-out.log`, "write", p);
      expect(result.allowed).toBe(true);
    });

    it("still blocks /private/var paths that are not $TMPDIR", () => {
      const result = evaluatePathAccess("/private/var/db/something.db", "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked_system_path");
    });
  });

  describe("/private/tmp (macOS /tmp symlink target)", () => {
    it("allows reading /private/tmp/claude/output.txt", () => {
      const result = evaluatePathAccess("/private/tmp/claude/output.txt", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("allows writing /private/tmp/claude/scratch.txt", () => {
      const result = evaluatePathAccess("/private/tmp/claude/scratch.txt", "write", policy());
      expect(result.allowed).toBe(true);
    });
  });

  describe("cross-project config allows harness config dirs", () => {
    it("allows CLAUDE.md within ~/.claude", () => {
      const result = evaluatePathAccess("~/.claude/CLAUDE.md", "read", policy());
      expect(result.allowed).toBe(true);
    });

    it("blocks .aider.conf.yml from another project", () => {
      const other = path.join(HOME, "src/other-project/.aider.conf.yml");
      const result = evaluatePathAccess(other, "read", policy());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("cross_project_agent_config");
    });
  });
});

describe("extractBashFilePaths", () => {
  it("extracts cat target", () => {
    expect(extractBashFilePaths("cat /etc/passwd")).toContain("/etc/passwd");
  });

  it("extracts redirect target", () => {
    expect(extractBashFilePaths("echo hi > /tmp/evil.sh")).toContain("/tmp/evil.sh");
  });

  it("extracts cp source and destination", () => {
    const paths = extractBashFilePaths("cp /etc/passwd /tmp/stolen");
    expect(paths).toContain("/etc/passwd");
    expect(paths).toContain("/tmp/stolen");
  });

  it("ignores flags", () => {
    const paths = extractBashFilePaths("head -n 10 file.txt");
    expect(paths).not.toContain("-n");
  });
});
