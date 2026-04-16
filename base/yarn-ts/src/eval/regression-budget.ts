import type { ScenarioResult } from "./types.js";

export interface RegressionMetrics {
  scenarioCount: number;
  passRate: number;
  avgScore: number;
  interventionRate: number;
  repeatedCommandAnomalyRate: number;
  avgTurnsToResolution: number;
}

export interface RegressionBudgetThresholds {
  maxPassRateDrop: number;
  maxScoreDrop: number;
  maxInterventionRateIncrease: number;
  maxRepeatedCommandAnomalyRateIncrease: number;
  maxAvgTurnsIncrease: number;
}

export interface RegressionBudgetViolation {
  metric: keyof Omit<RegressionMetrics, "scenarioCount">;
  baseline: number;
  candidate: number;
  delta: number;
  threshold: number;
  direction: "drop" | "increase";
}

export interface RegressionBudgetEvaluation {
  pass: boolean;
  baseline: RegressionMetrics;
  candidate: RegressionMetrics;
  thresholds: RegressionBudgetThresholds;
  violations: RegressionBudgetViolation[];
}

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionBudgetThresholds = {
  maxPassRateDrop: 0.03,
  maxScoreDrop: 0.03,
  maxInterventionRateIncrease: 0.1,
  maxRepeatedCommandAnomalyRateIncrease: 0.08,
  maxAvgTurnsIncrease: 0.4,
};

function safeDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function computeRegressionMetrics(results: ScenarioResult[]): RegressionMetrics {
  const scenarioCount = results.length;
  if (scenarioCount === 0) {
    return {
      scenarioCount: 0,
      passRate: 0,
      avgScore: 0,
      interventionRate: 0,
      repeatedCommandAnomalyRate: 0,
      avgTurnsToResolution: 0,
    };
  }

  let passed = 0;
  let scoreTotal = 0;
  let interventions = 0;
  let totalTurns = 0;
  let repeatedCommandAnomalies = 0;

  for (const r of results) {
    if (r.passed) passed += 1;
    scoreTotal += r.score;
    if (r.governorInterventions > 0) interventions += 1;
    totalTurns += r.totalTurns;
    for (const turn of r.turnResults) {
      for (const anomaly of turn.anomalies) {
        if (anomaly.kind === "repeated_tool_call" || anomaly.kind === "repeated_content") {
          repeatedCommandAnomalies += 1;
        }
      }
    }
  }

  return {
    scenarioCount,
    passRate: round3(safeDiv(passed, scenarioCount)),
    avgScore: round3(safeDiv(scoreTotal, scenarioCount)),
    interventionRate: round3(safeDiv(interventions, scenarioCount)),
    repeatedCommandAnomalyRate: round3(safeDiv(repeatedCommandAnomalies, scenarioCount)),
    avgTurnsToResolution: round3(safeDiv(totalTurns, scenarioCount)),
  };
}

export function evaluateRegressionBudget(params: {
  baseline: ScenarioResult[];
  candidate: ScenarioResult[];
  thresholds?: Partial<RegressionBudgetThresholds>;
}): RegressionBudgetEvaluation {
  const baseline = computeRegressionMetrics(params.baseline);
  const candidate = computeRegressionMetrics(params.candidate);
  const thresholds: RegressionBudgetThresholds = {
    ...DEFAULT_REGRESSION_THRESHOLDS,
    ...(params.thresholds ?? {}),
  };

  const violations: RegressionBudgetViolation[] = [];
  const passRateDelta = candidate.passRate - baseline.passRate;
  if (passRateDelta < -thresholds.maxPassRateDrop) {
    violations.push({
      metric: "passRate",
      baseline: baseline.passRate,
      candidate: candidate.passRate,
      delta: round3(passRateDelta),
      threshold: thresholds.maxPassRateDrop,
      direction: "drop",
    });
  }

  const scoreDelta = candidate.avgScore - baseline.avgScore;
  if (scoreDelta < -thresholds.maxScoreDrop) {
    violations.push({
      metric: "avgScore",
      baseline: baseline.avgScore,
      candidate: candidate.avgScore,
      delta: round3(scoreDelta),
      threshold: thresholds.maxScoreDrop,
      direction: "drop",
    });
  }

  const interventionDelta = candidate.interventionRate - baseline.interventionRate;
  if (interventionDelta > thresholds.maxInterventionRateIncrease) {
    violations.push({
      metric: "interventionRate",
      baseline: baseline.interventionRate,
      candidate: candidate.interventionRate,
      delta: round3(interventionDelta),
      threshold: thresholds.maxInterventionRateIncrease,
      direction: "increase",
    });
  }

  const repeatedCmdDelta = candidate.repeatedCommandAnomalyRate - baseline.repeatedCommandAnomalyRate;
  if (repeatedCmdDelta > thresholds.maxRepeatedCommandAnomalyRateIncrease) {
    violations.push({
      metric: "repeatedCommandAnomalyRate",
      baseline: baseline.repeatedCommandAnomalyRate,
      candidate: candidate.repeatedCommandAnomalyRate,
      delta: round3(repeatedCmdDelta),
      threshold: thresholds.maxRepeatedCommandAnomalyRateIncrease,
      direction: "increase",
    });
  }

  const turnsDelta = candidate.avgTurnsToResolution - baseline.avgTurnsToResolution;
  if (turnsDelta > thresholds.maxAvgTurnsIncrease) {
    violations.push({
      metric: "avgTurnsToResolution",
      baseline: baseline.avgTurnsToResolution,
      candidate: candidate.avgTurnsToResolution,
      delta: round3(turnsDelta),
      threshold: thresholds.maxAvgTurnsIncrease,
      direction: "increase",
    });
  }

  return {
    pass: violations.length === 0,
    baseline,
    candidate,
    thresholds,
    violations,
  };
}
