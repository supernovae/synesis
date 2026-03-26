import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "../src/policy/deterministic-policy-engine.js";

describe("DeterministicPolicyEngine", () => {
  it("rejects write_file tools via patch-first rule", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      tools: [{ function: { name: "write_file" } }]
    });
    expect(out.allow).toBe(false);
    expect(out.rejectReason).toContain("Patch-first policy violation");
    expect(out.matchedRules).toContain("patch_first_reject_write_file");
  });

  it("allows safe tools", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      tools: [{ function: { name: "apply_patch" } }]
    });
    expect(out.allow).toBe(true);
    expect(out.pivotPrompt).toBeUndefined();
  });

  it("triggers pivot on third repeated attempt", () => {
    const engine = new DeterministicPolicyEngine();
    const ctx = {
      repeatAttempt: {
        action: "chat_completion",
        args: { model: "synesis-core" },
        fsFingerprint: "abc"
      }
    };
    expect(engine.evaluate(ctx).pivotPrompt).toBeUndefined();
    expect(engine.evaluate(ctx).pivotPrompt).toBeUndefined();
    const third = engine.evaluate(ctx);
    expect(third.allow).toBe(true);
    expect(third.pivotPrompt).toContain("attempted this 3 times");
    expect(third.matchedRules).toContain("repeat_loop_pivot");
  });

  it("tracks policy stats", () => {
    const engine = new DeterministicPolicyEngine();
    engine.evaluate({ tools: [{ function: { name: "write_file" } }] });
    engine.evaluate({ repeatAttempt: { action: "x", args: {}, fsFingerprint: "f" } });
    engine.evaluate({ repeatAttempt: { action: "x", args: {}, fsFingerprint: "f" } });
    engine.evaluate({ repeatAttempt: { action: "x", args: {}, fsFingerprint: "f" } });
    const stats = engine.getStats();
    expect(stats.evaluations).toBe(4);
    expect(stats.rejectedCount).toBe(1);
    expect(stats.pivotCount).toBe(1);
  });
});
