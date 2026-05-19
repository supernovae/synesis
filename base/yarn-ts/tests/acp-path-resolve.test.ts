import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePathForAcp } from "../src/acp/synesis-yarn-acp-agent.js";

describe("resolvePathForAcp", () => {
  it("keeps absolute paths", () => {
    const abs = path.resolve("/abs", "foo.txt");
    expect(resolvePathForAcp(abs, {})).toBe(abs);
  });

  it("resolves relative to synesis_project_root", () => {
    expect(resolvePathForAcp("src/x.ts", { synesis_project_root: "/proj" })).toBe(path.resolve("/proj", "src/x.ts"));
  });

  it("falls back to synesis_shell_cwd when project root missing", () => {
    expect(resolvePathForAcp("x.go", { synesis_shell_cwd: "/tmp/wd" })).toBe(path.resolve("/tmp/wd", "x.go"));
  });

  it("resolves relative paths from shell_cwd when both shell_cwd and project root are set", () => {
    const out = resolvePathForAcp("overseerr-k8s.yaml", {
      synesis_project_root: "/home/byron/k8",
      synesis_shell_cwd: "/home/byron/k8/overseerr",
    });
    expect(out).toBe(path.resolve("/home/byron/k8/overseerr/overseerr-k8s.yaml"));
  });

  it("rejects absolute paths outside an explicit project root", () => {
    expect(() => resolvePathForAcp("/tmp/outside.go", { synesis_project_root: "/Users/me/repo" }))
      .toThrow("Path escapes project root");
  });

  it("rejects absolute paths outside the shell-cwd fallback boundary", () => {
    expect(() => resolvePathForAcp("/tmp/outside.go", { synesis_shell_cwd: "/Users/me/repo" }))
      .toThrow("Path escapes project root");
  });

  it("preserves absolute paths when no workspace anchor is set", () => {
    const out = resolvePathForAcp("/tmp/outside.go", {});
    expect(out).toBe(path.resolve("/tmp/outside.go"));
  });

  it("treats missing-leading-slash host paths as absolute-like", () => {
    const out = resolvePathForAcp("Users/me/repo/main.go", { synesis_project_root: "/Users/me/repo" });
    expect(out).toBe(path.resolve("/Users/me/repo", "main.go"));
  });

  it("normalizes Windows absolute-style paths on non-Windows hosts", () => {
    const out = resolvePathForAcp("C:\\Users\\dev\\secret.go", {});
    expect(out).toBe(path.resolve("/Users/dev/secret.go"));
  });

  it("strips a duplicated project-root basename from relative paths", () => {
    const out = resolvePathForAcp("k8/overseerr/overseerr-k8s.yaml", {
      synesis_project_root: "/home/byron/k8",
      synesis_shell_cwd: "/home/byron/k8/overseerr",
    });
    expect(out).toBe(path.resolve("/home/byron/k8/overseerr/overseerr-k8s.yaml"));
  });

  it("repairs shell-cwd-prefixed paths when no project root is available", () => {
    const out = resolvePathForAcp("k8/overseerr/overseerr-k8s.yaml", {
      synesis_shell_cwd: "/home/byron/k8/overseerr",
    });
    expect(out).toBe(path.resolve("/home/byron/k8/overseerr/overseerr-k8s.yaml"));
  });

  it("repairs shell-cwd basename-prefixed paths when no project root is available", () => {
    const out = resolvePathForAcp("overseerr/overseerr-k8s.yaml", {
      synesis_shell_cwd: "/home/byron/k8/overseerr",
    });
    expect(out).toBe(path.resolve("/home/byron/k8/overseerr/overseerr-k8s.yaml"));
  });
});
