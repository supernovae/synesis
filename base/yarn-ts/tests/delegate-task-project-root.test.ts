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

  it("uses args.projectRoot when non-empty", () => {
    const root = projectRootFromArgs({ projectRoot: "/repo/explicit" }, "/repo/fallback");
    expect(root).toBe("/repo/explicit");
  });
});
