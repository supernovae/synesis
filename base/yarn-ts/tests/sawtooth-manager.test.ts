import { describe, expect, it, vi } from "vitest";
import { SawtoothContextManager } from "../src/context/sawtooth-manager.js";

describe("SawtoothContextManager", () => {
  it("checkpoints at configured tool call threshold", () => {
    const mgr = new SawtoothContextManager(10);
    expect(
      mgr.shouldCheckpoint(
        [{ role: "user", content: "x" }],
        9
      )
    ).toBe(false);
    expect(
      mgr.shouldCheckpoint(
        [{ role: "user", content: "x" }],
        10
      )
    ).toBe(true);
  });

  it("produces heuristic consolidation when no compactFn set", async () => {
    const mgr = new SawtoothContextManager();
    const out = await mgr.compressTrajectory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ]);
    expect(out.summary).toContain("<ARCHITECTURAL_STATE>");
    expect(out.summary).toContain("heuristic");
    expect(out.archivedMessageCount).toBeGreaterThanOrEqual(0);
  });

  it("uses compactFn for LLM-based compaction when provided", async () => {
    const mgr = new SawtoothContextManager();
    const mockCompact = vi.fn().mockResolvedValue("<ARCHITECTURAL_STATE>LLM summary</ARCHITECTURAL_STATE>");
    mgr.setCompactFn(mockCompact);
    const out = await mgr.compressTrajectory([
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "done" }
    ]);
    expect(mockCompact).toHaveBeenCalledOnce();
    expect(out.summary).toBe("<ARCHITECTURAL_STATE>LLM summary</ARCHITECTURAL_STATE>");
    expect(out.archivedMessageCount).toBe(1);
  });

  it("falls back to heuristic when compactFn throws", async () => {
    const mgr = new SawtoothContextManager();
    mgr.setCompactFn(vi.fn().mockRejectedValue(new Error("model down")));
    const out = await mgr.compressTrajectory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ]);
    expect(out.summary).toContain("<ARCHITECTURAL_STATE>");
    expect(out.summary).toContain("heuristic");
  });
});
