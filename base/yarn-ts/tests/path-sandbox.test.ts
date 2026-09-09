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
  it.each(["/home/client/repo", "C:/Users/client/repo", "/workspace"])("checks client paths independently of proxy OS: %s", root => {
    const p = buildDefaultPolicy(root);
    expect(evaluatePathAccess("src/main.ts", "write", p).allowed).toBe(true);
    expect(evaluatePathAccess("../other/main.ts", "write", p).allowed).toBe(false);
    expect(evaluatePathAccess(root + "-other/a.ts", "read", p).allowed).toBe(false);
  });
  it.each(["~/.hermes/config.yaml", "~/.claude/settings.json", "~/.codex/auth.json", "/tmp/other/a", "/etc/passwd"])("does not infer a grant for %s", target => {
    expect(evaluatePathAccess(target, "read", policy()).allowed).toBe(false);
    expect(evaluatePathAccess(target, "write", policy()).allowed).toBe(false);
  });
  it("uses explicit external grants and keeps read/write separate", () => {
    const p = buildDefaultPolicy("/workspace", { homeDir: "/home/client",
      allowedReadGlobs: ["~/.hermes/skills/**"], allowedWriteGlobs: ["/scratch/session/**"] });
    expect(evaluatePathAccess("~/.hermes/skills/a.md", "read", p).allowed).toBe(true);
    expect(evaluatePathAccess("~/.hermes/skills/a.md", "write", p).allowed).toBe(false);
    expect(evaluatePathAccess("/scratch/session/log", "write", p).allowed).toBe(true);
    expect(evaluatePathAccess("/scratch/session-other/log", "write", p).allowed).toBe(false);
  });
  it("explicit deny wins inside workspace and external grants", () => {
    const p = buildDefaultPolicy("/workspace", { allowedReadGlobs: ["/scratch/**"], blockedGlobs: ["/workspace/.env", "/scratch/secret/**"] });
    expect(evaluatePathAccess(".env", "read", p).allowed).toBe(false);
    expect(evaluatePathAccess("/scratch/secret/a", "read", p).allowed).toBe(false);
  });
  it("does not inherit the proxy home or tmp directory", () => {
    const p = buildDefaultPolicy("/workspace");
    expect(p.homeDir).toBe("");
    expect(p.allowedReadGlobs).toEqual([]);
    expect(p.allowedWriteGlobs).toEqual([]);
  });
  it("rejects invalid context and allows null sink", () => {
    expect(evaluatePathAccess("a", "write", buildDefaultPolicy("relative")).allowed).toBe(false);
    expect(evaluatePathAccess("a\u0000b", "write", buildDefaultPolicy("/workspace")).allowed).toBe(false);
    expect(evaluatePathAccess("/dev/null", "write", buildDefaultPolicy("/workspace")).allowed).toBe(true);
    expect(projectTmpDir("/workspace/repo")).toBe("/tmp/repo");
  });
});

describe("extractBashFilePaths", () => {
  it("extracts cat target", () => {
    expect(extractBashFilePaths("cat /etc/passwd")).toContain("/etc/passwd");
  });

  it("extracts redirect target", () => {
    expect(extractBashFilePaths("echo hi > /tmp/evil.sh")).toContain("/tmp/evil.sh");
  });

  it("extracts /dev/null redirect target", () => {
    expect(extractBashFilePaths("find . -type f 2>/dev/null | sort")).toContain("/dev/null");
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
