import { describe, expect, it } from "vitest";
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

  it("produces architectural state consolidation block", async () => {
    const mgr = new SawtoothContextManager();
    const out = await mgr.compressTrajectory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ]);
    expect(out.summary).toContain("<ARCHITECTURAL_STATE>");
    expect(out.summary).toContain("</ARCHITECTURAL_STATE>");
    expect(out.archivedMessageCount).toBeGreaterThanOrEqual(0);
  });
});
