import { describe, expect, it } from "vitest";

import { computePairedAccuracy } from "../src/eval/paired-evaluation.js";
import { ABSTENTION_SCENARIOS } from "../src/eval/scenarios/abstention.js";
import type { ScenarioResult } from "../src/eval/types.js";

function result(
  pairId: string,
  expectedDecision: "act" | "abstain",
  passed: boolean,
): ScenarioResult {
  return {
    scenarioId: `${pairId}-${expectedDecision}`,
    scenarioName: pairId,
    category: "abstention",
    evaluationPair: { id: pairId, expectedDecision },
    passed,
    score: passed ? 1 : 0,
    totalTurns: 1,
    totalToolRounds: 0,
    totalAnomalies: 0,
    governorInterventions: 0,
    allGovernorRules: [],
    turnResults: [],
    failureReasons: [],
    durationMs: 1,
    targetUrl: "http://test",
    model: "test",
    timestamp: "2026-08-25T00:00:00.000Z",
  };
}

describe("paired act/abstain evaluation", () => {
  it("counts a pair only when both variants pass", () => {
    const metrics = computePairedAccuracy([
      result("safe", "act", true),
      result("safe", "abstain", true),
      result("unsafe", "act", true),
      result("unsafe", "abstain", false),
    ]);
    expect(metrics).toEqual({
      completePairs: 2,
      passedPairs: 1,
      pairedAccuracy: 0.5,
      incompletePairIds: [],
    });
  });

  it("reports incomplete pairs without inflating accuracy", () => {
    const metrics = computePairedAccuracy([result("half", "act", true)]);
    expect(metrics.completePairs).toBe(0);
    expect(metrics.pairedAccuracy).toBeNull();
    expect(metrics.incompletePairIds).toEqual(["half"]);
  });

  it("ships complete controlled pairs with action-specific assertions", () => {
    const pairs = new Map<string, Set<string>>();
    for (const scenario of ABSTENTION_SCENARIOS) {
      expect(scenario.category).toBe("abstention");
      expect(scenario.evaluationPair).toBeDefined();
      const pair = scenario.evaluationPair!;
      const decisions = pairs.get(pair.id) ?? new Set<string>();
      decisions.add(pair.expectedDecision);
      pairs.set(pair.id, decisions);
      const assertions = scenario.turns.flatMap((turn) => turn.assertions ?? []);
      expect(assertions.some((assertion) =>
        assertion.type === (pair.expectedDecision === "act" ? "tool_name_present" : "tool_name_absent")
      )).toBe(true);
    }
    expect([...pairs.values()].every((decisions) =>
      decisions.has("act") && decisions.has("abstain") && decisions.size === 2
    )).toBe(true);
  });
});
