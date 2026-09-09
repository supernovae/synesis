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

  it("normalizes ACP metadata anchors before resolving paths", () => {
    const out = resolvePathForAcp("src/x.ts", {
      synesis_project_root: " /proj/app/../app ",
    });
    expect(out).toBe(path.resolve("/proj/app", "src/x.ts"));
  });

  it("rejects relative paths without valid ACP metadata anchors", () => {
    expect(() => resolvePathForAcp("src/x.ts", {
      synesis_project_root: "/proj\nrole=admin",
      synesis_shell_cwd: "relative/cwd",
    })).toThrow("requires session cwd");
  });

  it("drops shell_cwd when it escapes the project root", () => {
    const out = resolvePathForAcp("x.go", {
      synesis_project_root: "/repo/app",
      synesis_shell_cwd: "/repo/other",
    });
    expect(out).toBe(path.resolve("/repo/app", "x.go"));
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

  it.each(["k8/overseerr/config.yaml", "overseerr/config.yaml", "Users/me/file"])("preserves repeated and home-like relative names: %s", file => {
    expect(resolvePathForAcp(file, { synesis_project_root: "/home/dev/k8", synesis_shell_cwd: "/home/dev/k8/overseerr" }))
      .toBe(`/home/dev/k8/overseerr/${file}`);
  });
  it("resolves Windows client paths without dropping the drive", () => {
    expect(resolvePathForAcp("src/a.ts", { synesis_project_root: "C:\\repo" })).toBe("C:\\repo\\src\\a.ts");
    expect(() => resolvePathForAcp("D:\\repo\\a.ts", { synesis_project_root: "C:\\repo" })).toThrow("escapes project root");
  });
  it("never falls back to the proxy cwd", () => {
    expect(() => resolvePathForAcp("a.ts", {})).toThrow("requires session cwd");
    expect(() => resolvePathForAcp("a\u0000.ts", { synesis_project_root: "/repo" })).toThrow("Invalid ACP file path");
  });
});
