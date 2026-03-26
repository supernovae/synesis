import { describe, expect, it } from "vitest";
import { EXTENSION_HEURISTICS } from "../src/context/heuristics.js";
import { SawtoothContextManager } from "../src/context/sawtooth-manager.js";

describe("EXTENSION_HEURISTICS", () => {
  it("maps .ts to 80 maxInlineLogLines", () => {
    expect(EXTENSION_HEURISTICS[".ts"]).toEqual({ extension: ".ts", maxInlineLogLines: 80 });
  });

  it("maps .py to 80 maxInlineLogLines", () => {
    expect(EXTENSION_HEURISTICS[".py"]?.maxInlineLogLines).toBe(80);
  });

  it("maps .go to 70 maxInlineLogLines", () => {
    expect(EXTENSION_HEURISTICS[".go"]?.maxInlineLogLines).toBe(70);
  });

  it("maps .yaml to 50 maxInlineLogLines", () => {
    expect(EXTENSION_HEURISTICS[".yaml"]?.maxInlineLogLines).toBe(50);
  });

  it("maps .sh to 60 maxInlineLogLines", () => {
    expect(EXTENSION_HEURISTICS[".sh"]?.maxInlineLogLines).toBe(60);
  });

  it("does not have an entry for unknown extensions", () => {
    expect(EXTENSION_HEURISTICS[".xyz"]).toBeUndefined();
  });
});

describe("SawtoothContextManager.getLanguageHeuristics", () => {
  const mgr = new SawtoothContextManager();

  it("returns extension-specific heuristic for known type", () => {
    const h = mgr.getLanguageHeuristics(".ts");
    expect(h.extension).toBe(".ts");
    expect(h.maxInlineLogLines).toBe(80);
  });

  it("returns fallback for unknown extension", () => {
    const h = mgr.getLanguageHeuristics(".xyz");
    expect(h.extension).toBe(".xyz");
    expect(h.maxInlineLogLines).toBe(60);
  });

  it("returns fallback for empty extension", () => {
    const h = mgr.getLanguageHeuristics("");
    expect(h.extension).toBe("");
    expect(h.maxInlineLogLines).toBe(60);
  });
});
