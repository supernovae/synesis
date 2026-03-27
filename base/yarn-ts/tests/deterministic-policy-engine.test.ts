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

  it("hard rejects after configurable repeat limit", () => {
    const engine = new DeterministicPolicyEngine();
    const ctx = {
      repeatAttempt: {
        action: "chat_completion",
        args: { model: "synesis-core" },
        fsFingerprint: "abc"
      },
      hardRejectAfter: 4
    };
    engine.evaluate(ctx);
    engine.evaluate(ctx);
    const third = engine.evaluate(ctx);
    expect(third.allow).toBe(true);
    expect(third.pivotPrompt).toBeDefined();

    const fourth = engine.evaluate(ctx);
    expect(fourth.allow).toBe(false);
    expect(fourth.rejectReason).toContain("repeated 4 times");
    expect(fourth.matchedRules).toContain("repeat_loop_hard_reject");
  });

  it("hard rejects when session token budget exceeded", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      sessionKey: "test-session",
      sessionTokensIn: 600_000,
      maxInputTokens: 500_000
    });
    expect(out.allow).toBe(false);
    expect(out.rejectReason).toContain("Session token budget exceeded");
    expect(out.matchedRules).toContain("session_budget_exceeded");
  });

  it("allows requests within token budget", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      sessionKey: "test-session",
      sessionTokensIn: 200_000,
      maxInputTokens: 500_000
    });
    expect(out.allow).toBe(true);
  });

  it("hard rejects consecutive tool calls exceeding limit", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      sessionKey: "test-session",
      consecutiveToolCalls: 10,
      consecutiveToolCallsLimit: 8
    });
    expect(out.allow).toBe(false);
    expect(out.rejectReason).toContain("Tool call loop detected");
    expect(out.matchedRules).toContain("consecutive_tool_calls_limit");
  });

  it("allows consecutive tool calls below limit", () => {
    const engine = new DeterministicPolicyEngine();
    const out = engine.evaluate({
      sessionKey: "test-session",
      consecutiveToolCalls: 5,
      consecutiveToolCallsLimit: 8
    });
    expect(out.allow).toBe(true);
  });

  it("records safety events in ring buffer", () => {
    const engine = new DeterministicPolicyEngine();
    engine.evaluate({
      sessionKey: "sess-1",
      sessionTokensIn: 600_000,
      maxInputTokens: 500_000
    });
    const events = engine.getRecentEvents();
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("hard_reject_budget");
    expect(events[0].sessionKey).toBe("sess-1");
  });

  it("tracks comprehensive stats", () => {
    const engine = new DeterministicPolicyEngine();
    engine.evaluate({ tools: [{ function: { name: "write_file" } }] });
    engine.evaluate({
      sessionKey: "s1",
      sessionTokensIn: 600_000,
      maxInputTokens: 500_000
    });
    engine.evaluate({
      sessionKey: "s2",
      consecutiveToolCalls: 10,
      consecutiveToolCallsLimit: 8
    });
    const repeat = {
      repeatAttempt: { action: "x", args: {}, fsFingerprint: "f" },
      hardRejectAfter: 4,
      sessionKey: "s3"
    };
    engine.evaluate(repeat);
    engine.evaluate(repeat);
    engine.evaluate(repeat);
    engine.evaluate(repeat);

    const stats = engine.getStats();
    expect(stats.evaluations).toBe(7);
    expect(stats.rejectedCount).toBe(4);
    expect(stats.pivotCount).toBe(1);
    expect(stats.hardRejectRepeatCount).toBe(1);
    expect(stats.hardRejectBudgetCount).toBe(1);
    expect(stats.hardRejectToolLoopCount).toBe(1);
    expect(stats.recentEvents.length).toBe(5);
  });

  it("pivot prompt includes attempts remaining", () => {
    const engine = new DeterministicPolicyEngine();
    const ctx = {
      repeatAttempt: { action: "a", args: {}, fsFingerprint: "f" },
      hardRejectAfter: 6
    };
    engine.evaluate(ctx);
    engine.evaluate(ctx);
    const third = engine.evaluate(ctx);
    expect(third.pivotPrompt).toContain("3 attempts remaining");
  });
});
