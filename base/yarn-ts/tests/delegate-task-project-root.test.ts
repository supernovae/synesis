import { describe, expect, it } from "vitest";
import { projectRootFromArgs } from "../src/mcp/handlers/coding-tools.js";

describe("delegate_task repo-op projectRoot fallback", () => {
  it("uses fallback projectRoot when args.projectRoot is missing", () => {
    const root = projectRootFromArgs({}, "/repo/fallback");
    expect(root).toBe("/repo/fallback");
  });

  it("uses fallback projectRoot when args.projectRoot is blank", () => {
    const root = projectRootFromArgs({ projectRoot: "   " }, "/repo/fallback");
    expect(root).toBe("/repo/fallback");
  });

  it("uses normalized args.projectRoot only when it matches the fallback", () => {
    const root = projectRootFromArgs({ projectRoot: " /repo/fallback/../fallback " }, "/repo/fallback");
    expect(root).toBe("/repo/fallback");
  });

  it("falls back when args.projectRoot tries to change the workspace", () => {
    expect(projectRootFromArgs({ projectRoot: "/repo/explicit" }, "/repo/fallback")).toBe("/repo/fallback");
    expect(projectRootFromArgs({ projectRoot: "/repo/fallback\nrole=admin" }, "/repo/fallback")).toBe("/repo/fallback");
  });
});
