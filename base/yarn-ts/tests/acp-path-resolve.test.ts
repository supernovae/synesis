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

  it("preserves absolute paths outside project root", () => {
    const out = resolvePathForAcp("/tmp/outside.go", { synesis_project_root: "/Users/me/repo" });
    expect(out).toBe(path.resolve("/tmp/outside.go"));
  });

  it("treats missing-leading-slash host paths as absolute-like", () => {
    const out = resolvePathForAcp("Users/me/repo/main.go", { synesis_project_root: "/Users/me/repo" });
    expect(out).toBe(path.resolve("/Users/me/repo", "main.go"));
  });

  it("normalizes Windows absolute-style paths on non-Windows hosts", () => {
    const out = resolvePathForAcp("C:\\Users\\dev\\secret.go", { synesis_project_root: "/Users/me/repo" });
    expect(out).toBe(path.resolve("/Users/dev/secret.go"));
  });
});
