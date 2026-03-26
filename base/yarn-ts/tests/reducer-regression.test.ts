import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReducerFamily } from "../src/reduction/classifier.js";
import { ReducerRegistry } from "../src/reduction/registry.js";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", "reducers", `${name}.txt`), "utf8");
}

describe("ReducerRegistry regression", () => {
  const registry = new ReducerRegistry({
    enabled: true,
    enabledFamilies: new Set(["pytest", "tsc", "lint", "git", "search"]),
    minConfidence: 0.6
  });

  it("classifies pytest", () => {
    expect(classifyReducerFamily("pytest", "pytest", fixture("pytest"))).toBe("pytest");
  });

  it("reduces pytest fixture", () => {
    const out = registry.reduce({
      raw: fixture("pytest"),
      context: { toolName: "pytest", command: "pytest", profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
    });
    expect(out?.summary).toContain('family="pytest"');
  });

  it("reduces tsc fixture", () => {
    const out = registry.reduce({
      raw: fixture("tsc"),
      context: { toolName: "tsc", command: "tsc --noEmit", profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
    });
    expect(out?.summary).toContain('family="tsc"');
  });

  it("reduces lint fixture", () => {
    const lintRaw = "src/a.ts:1:1: F401 unused import\nsrc/b.ts:5:1: error  'x' is assigned but never used  @typescript-eslint/no-unused-vars";
    expect(classifyReducerFamily("ruff", "ruff check", lintRaw)).toBe("lint");
  });

  it("reduces git fixture", () => {
    const out = registry.reduce({
      raw: fixture("git"),
      context: { toolName: "bash", command: "git status", profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
    });
    expect(out?.summary).toContain('family="git"');
  });

  it("reduces search fixture", () => {
    const out = registry.reduce({
      raw: fixture("search"),
      context: { toolName: "bash", command: "rg run", profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
    });
    expect(out?.summary).toContain('family="search"');
  });
});
