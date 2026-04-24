import { describe, expect, it } from "vitest";
import { computeRegressionMetrics, evaluateRegressionBudget } from "../src/eval/regression-budget.js";
import type { ScenarioResult } from "../src/eval/types.js";

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ScenarioResult["turnResults"][number]["messages"][number] {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function makeScenario(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "s1",
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
      messages: [
        { role: "user", content: "u" },
        assistantToolCall("tc-default-read", "read_file", { path: "src/app.ts" }),
        assistantToolCall("tc-default-edit", "str_replace", { path: "src/app.ts" }),
      ],
      governorRulesFired: [],
      assertionResults: [],
      latencyMs: 20,
      anomalies: [],
    }],
    failureReasons: [],
    durationMs: 100,
    targetUrl: "http://test",
    model: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeRegressionMetrics", () => {
  it("computes pass and anomaly/intervention rates", () => {
    const input = [
      makeScenario(),
      makeScenario({
        scenarioId: "s2",
        passed: false,
        score: 0.4,
        governorInterventions: 1,
        totalTurns: 3,
        turnResults: [{
          turnIndex: 0,
          toolRounds: 2,
          messages: [
            { role: "user", content: "u" },
            assistantToolCall("tc-whole-write", "write_file", { path: "src/app.ts" }),
          ],
          governorRulesFired: ["verification_churn_no_edit", "completion_claim_requires_task_update"],
          assertionResults: [],
          latencyMs: 10,
          anomalies: [
            { kind: "repeated_tool_call", detail: "same bash", severity: "error" },
          ],
        }],
      }),
    ];

    const metrics = computeRegressionMetrics(input);
    expect(metrics.scenarioCount).toBe(2);
    expect(metrics.passRate).toBe(0.5);
    expect(metrics.interventionRate).toBe(0.5);
    expect(metrics.repeatedCommandAnomalyRate).toBe(0.5);
    expect(metrics.avgTurnsToResolution).toBe(2);
    expect(metrics.readEditRatio).toBe(0.5);
    expect(metrics.wholeWriteRatio).toBe(0.5);
    expect(metrics.prematureStopSignalRate).toBe(0.5);
  });
});

describe("evaluateRegressionBudget", () => {
  it("passes when candidate stays within thresholds", () => {
    const baseline = [makeScenario(), makeScenario({ scenarioId: "s2", score: 0.8, totalTurns: 2 })];
    const candidate = [makeScenario({ score: 0.99 }), makeScenario({ scenarioId: "s2", score: 0.8, totalTurns: 2 })];
    const out = evaluateRegressionBudget({ baseline, candidate });
    expect(out.pass).toBe(true);
    expect(out.violations).toHaveLength(0);
  });

  it("fails when candidate regresses on pass-rate and loop metrics", () => {
    const baseline = [makeScenario(), makeScenario({ scenarioId: "s2" }), makeScenario({ scenarioId: "s3" })];
    const candidate = [
      makeScenario({
        scenarioId: "s1",
        passed: false,
        score: 0.2,
        totalTurns: 4,
        governorInterventions: 1,
        turnResults: [{
          turnIndex: 0,
          toolRounds: 1,
          messages: [
            { role: "user", content: "u" },
            assistantToolCall("tc-s1-whole-write", "write_file", { path: "src/s1.ts" }),
          ],
          governorRulesFired: ["completion_claim_requires_task_update"],
          assertionResults: [],
          latencyMs: 5,
          anomalies: [],
        }],
      }),
      makeScenario({
        scenarioId: "s2",
        passed: false,
        score: 0.1,
        totalTurns: 5,
        governorInterventions: 1,
        turnResults: [{
          turnIndex: 0,
          toolRounds: 1,
          messages: [
            { role: "user", content: "u" },
            assistantToolCall("tc-s2-whole-write", "write_file", { path: "src/s2.ts" }),
          ],
          governorRulesFired: ["verbal_intent_without_action"],
          assertionResults: [],
          latencyMs: 5,
          anomalies: [],
        }],
      }),
      makeScenario({
        scenarioId: "s3",
        passed: true,
        score: 0.6,
        totalTurns: 3,
        turnResults: [{
          turnIndex: 0,
          toolRounds: 1,
          messages: [
            { role: "user", content: "u" },
            assistantToolCall("tc-s3-write", "write_file", { path: "src/s3.ts" }),
          ],
          governorRulesFired: ["verification_after_completion_claim"],
          assertionResults: [],
          latencyMs: 5,
          anomalies: [{ kind: "repeated_content", detail: "repeat", severity: "warning" }],
        }],
      }),
    ];
    const out = evaluateRegressionBudget({
      baseline,
      candidate,
      thresholds: {
        maxPassRateDrop: 0.05,
        maxScoreDrop: 0.05,
        maxInterventionRateIncrease: 0.05,
        maxRepeatedCommandAnomalyRateIncrease: 0.05,
        maxAvgTurnsIncrease: 0.05,
        maxReadEditRatioDrop: 0.05,
        maxWholeWriteRatioIncrease: 0.05,
        maxPrematureStopSignalRateIncrease: 0.05,
      },
    });
    expect(out.pass).toBe(false);
    expect(out.violations.length).toBeGreaterThanOrEqual(5);
  });
});
