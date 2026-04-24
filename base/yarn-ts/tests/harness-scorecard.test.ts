import { describe, expect, it } from "vitest";
import {
  applyRollbackPolicy,
  buildHarnessScorecard,
  type HarnessScorecardHistoryEntry,
} from "../src/eval/harness-scorecard.js";
import type { RegressionBudgetEvaluation } from "../src/eval/regression-budget.js";
import type { ScenarioResult } from "../src/eval/types.js";

function makeScenario(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "scenario-a",
    scenarioName: "scenario",
    category: "governor_regression",
    passed: true,
    score: 1,
    totalTurns: 1,
    totalToolRounds: 1,
    totalAnomalies: 0,
    governorInterventions: 0,
    allGovernorRules: [],
    turnResults: [{
      turnIndex: 0,
      toolRounds: 1,
      messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }],
      governorRulesFired: [],
      assertionResults: [],
      latencyMs: 5,
      anomalies: [],
    }],
    failureReasons: [],
    durationMs: 20,
    targetUrl: "http://target",
    model: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBudget(overrides: Partial<RegressionBudgetEvaluation> = {}): RegressionBudgetEvaluation {
  return {
    pass: true,
    baseline: {
      scenarioCount: 2,
      passRate: 1,
      avgScore: 0.95,
      interventionRate: 0,
      repeatedCommandAnomalyRate: 0,
      avgTurnsToResolution: 2,
      readEditRatio: 2,
      wholeWriteRatio: 0.1,
      prematureStopSignalRate: 0,
    },
    candidate: {
      scenarioCount: 2,
      passRate: 0.8,
      avgScore: 0.85,
      interventionRate: 0.2,
      repeatedCommandAnomalyRate: 0.1,
      avgTurnsToResolution: 2.3,
      readEditRatio: 1.2,
      wholeWriteRatio: 0.3,
      prematureStopSignalRate: 0.2,
    },
    thresholds: {
      maxPassRateDrop: 0.03,
      maxScoreDrop: 0.03,
      maxInterventionRateIncrease: 0.1,
      maxRepeatedCommandAnomalyRateIncrease: 0.08,
      maxAvgTurnsIncrease: 0.4,
      maxReadEditRatioDrop: 0.75,
      maxWholeWriteRatioIncrease: 0.2,
      maxPrematureStopSignalRateIncrease: 0.15,
    },
    violations: [],
    ...overrides,
  };
}

describe("buildHarnessScorecard", () => {
  it("aggregates budget + canary breaches into red-line reasons", () => {
    const budget = makeBudget({
      pass: false,
      violations: [{
        metric: "readEditRatio",
        baseline: 2,
        candidate: 1.2,
        delta: -0.8,
        threshold: 0.75,
        direction: "drop",
      }],
    });
    const regressionResults = [makeScenario(), makeScenario({ scenarioId: "scenario-b" })];
    const canaryResults = [
      makeScenario({
        scenarioId: "canary-one",
        category: "power_user_canary",
        passed: false,
        allGovernorRules: ["governor:hard_stop"],
      }),
      makeScenario({
        scenarioId: "canary-two",
        category: "power_user_canary",
      }),
    ];
    const scorecard = buildHarnessScorecard({
      lane: "nightly",
      budgetEvaluation: budget,
      regressionResults,
      canaryResults,
    });

    expect(scorecard.redline.breached).toBe(true);
    expect(scorecard.redline.reasons).toContain("budget:readEditRatio:drop:-0.8");
    expect(scorecard.redline.reasons).toContain("canary_failure:canary-one");
    expect(scorecard.canary.pass_rate).toBe(0.5);
    expect(scorecard.canary.hard_stop_scenario_count).toBe(1);
  });
});

describe("applyRollbackPolicy", () => {
  it("holds rollout after threshold consecutive breaches", () => {
    const history: HarnessScorecardHistoryEntry[] = [{
      generated_at: "2026-01-01T00:00:00.000Z",
      lane: "nightly",
      redline_breached: true,
      redline_reasons: ["budget:passRate:drop:-0.1"],
      budget_pass: false,
      canary_pass_rate: 0.5,
    }];
    const scorecard = buildHarnessScorecard({
      lane: "nightly",
      budgetEvaluation: makeBudget({
        pass: false,
        violations: [{
          metric: "avgScore",
          baseline: 0.95,
          candidate: 0.7,
          delta: -0.25,
          threshold: 0.03,
          direction: "drop",
        }],
      }),
      regressionResults: [makeScenario()],
      canaryResults: [makeScenario({ scenarioId: "canary-a", category: "power_user_canary", passed: false })],
    });

    const { decision, updatedHistory } = applyRollbackPolicy({
      scorecard,
      history,
      breachThreshold: 2,
    });

    expect(decision.hold_rollout).toBe(true);
    expect(decision.action).toBe("hold_rollout");
    expect(decision.consecutive_redline_breaches).toBe(2);
    expect(updatedHistory).toHaveLength(2);
  });

  it("proceeds when there is no active red-line breach", () => {
    const scorecard = buildHarnessScorecard({
      lane: "main",
      budgetEvaluation: makeBudget({ pass: true, violations: [] }),
      regressionResults: [makeScenario()],
      canaryResults: [makeScenario({ scenarioId: "canary-ok", category: "power_user_canary" })],
    });

    const { decision } = applyRollbackPolicy({
      scorecard,
      history: [],
      breachThreshold: 2,
    });

    expect(decision.hold_rollout).toBe(false);
    expect(decision.action).toBe("proceed");
    expect(decision.consecutive_redline_breaches).toBe(0);
  });
});
