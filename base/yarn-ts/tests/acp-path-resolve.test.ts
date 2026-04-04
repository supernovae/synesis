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
});
