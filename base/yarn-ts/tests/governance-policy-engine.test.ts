import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "../src/policy/deterministic-policy-engine.js";
import type { GovernanceRule } from "../src/policy/governance-client.js";

function makeThresholdRule(config: Record<string, unknown>): GovernanceRule {
  return {
    source: "policy",
    policy_id: "test-policy",
    scope: "org",
    scope_precedence: 1,
    precedence: 0,
    category: "safety",
    constraint_kind: "guiding",
    rule_type: "threshold",
    rule_config: config,
    priority: 0,
  };
}

describe("DeterministicPolicyEngine — governance overrides", () => {
  it("overrides maxInputTokens from governance threshold rule", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      sessionTokensIn: 600_000,
      maxInputTokens: 500_000,
      governanceRules: [makeThresholdRule({ max_input_tokens: 1_000_000 })],
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedRules).toContain("governance_overrides_applied");
  });

  it("governance-lowered maxInputTokens causes budget reject", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      sessionTokensIn: 300_000,
      maxInputTokens: 500_000,
      governanceRules: [makeThresholdRule({ max_input_tokens: 200_000 })],
    });
    expect(decision.allow).toBe(false);
    expect(decision.matchedRules).toContain("session_budget_exceeded");
  });

  it("overrides consecutiveToolCallsLimit from governance", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      consecutiveToolCalls: 8,
      consecutiveToolCallsLimit: 15,
      consecutiveToolCallsPivot: 5,
      toolProgressState: "unknown",
      governanceRules: [makeThresholdRule({ tool_calls_pivot: 7 })],
    });
    expect(decision.allow).toBe(true);
    expect(decision.pivotPrompt).toBeDefined();
    expect(decision.matchedRules).toContain("consecutive_tool_calls_pivot");
  });

  it("overrides hardRejectAfter from governance", () => {
    const engine = new DeterministicPolicyEngine();
    const ctx = {
      repeatAttempt: {
        action: "chat_completion",
        args: { model: "synesis-core" },
        fsFingerprint: "test-fingerprint",
      },
      governanceRules: [makeThresholdRule({ hard_reject_after: 4 })],
    };
    engine.evaluate(ctx);
    engine.evaluate(ctx);
    engine.evaluate(ctx);
    const fourth = engine.evaluate(ctx);
    expect(fourth.allow).toBe(false);
    expect(fourth.matchedRules).toContain("repeat_loop_hard_reject");
  });

  it("no governance rules means no override applied", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      tools: [{ function: { name: "apply_patch" } }],
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedRules).not.toContain("governance_overrides_applied");
  });

  it("empty governance rules array does not trigger override", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      tools: [],
      governanceRules: [],
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedRules).not.toContain("governance_overrides_applied");
  });

  it("non-threshold rules are ignored by overrides", () => {
    const engine = new DeterministicPolicyEngine();
    const decision = engine.evaluate({
      sessionTokensIn: 100,
      maxInputTokens: 500_000,
      governanceRules: [{
        source: "policy",
        scope: "org",
        scope_precedence: 1,
        precedence: 0,
        category: "quality",
        constraint_kind: "advisory",
        rule_type: "feature_toggle",
        rule_config: { enable_reducers: false },
        priority: 0,
      }],
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedRules).toContain("governance_overrides_applied");
    expect(decision.matchedRules).not.toContain("session_budget_exceeded");
  });

  it("stats include governance_overrides_applied in matchedRules", () => {
    const engine = new DeterministicPolicyEngine();
    engine.evaluate({
      governanceRules: [makeThresholdRule({ max_input_tokens: 1_000_000 })],
    });
    const stats = engine.getStats();
    expect(stats.evaluations).toBe(1);
  });
});
