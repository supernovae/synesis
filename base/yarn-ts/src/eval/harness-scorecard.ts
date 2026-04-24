import type { RegressionBudgetEvaluation, RegressionBudgetViolation } from "./regression-budget.js";
import type { ScenarioResult } from "./types.js";

export interface HarnessScorecard {
  schema_version: "harness_scorecard_v1";
  generated_at: string;
  lane: string;
  metrics: {
    pass_rate: number;
    avg_score: number;
    intervention_rate: number;
    repeated_command_anomaly_rate: number;
    avg_turns_to_resolution: number;
    read_edit_ratio: number;
    whole_write_ratio: number;
    premature_stop_signal_rate: number;
  };
  budget: {
    pass: boolean;
    violation_count: number;
    violations: RegressionBudgetViolation[];
  };
  canary: {
    scenario_count: number;
    passed_count: number;
    failed_count: number;
    pass_rate: number;
    avg_score: number;
    avg_turns: number;
    hard_stop_scenario_count: number;
    failed_scenarios: string[];
  };
  redline: {
    breached: boolean;
    reasons: string[];
  };
  integrity: {
    regression_scenario_count: number;
    trajectory_row_count: number;
    canary_source: "file" | "scenario_prefix";
    canary_prefix: string;
  };
}

export interface HarnessScorecardHistoryEntry {
  generated_at: string;
  lane: string;
  redline_breached: boolean;
  redline_reasons: string[];
  budget_pass: boolean;
  canary_pass_rate: number;
}

export interface RollbackPolicyDecision {
  action: "proceed" | "hold_rollout";
  hold_rollout: boolean;
  consecutive_redline_breaches: number;
  threshold: number;
  reason: string;
  suggested_actions: string[];
}

export function safeDiv(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

export function round3(value: number): number {
  return Number(value.toFixed(3));
}

function scenarioHasHardStop(result: ScenarioResult): boolean {
  if (result.allGovernorRules.includes("governor:hard_stop")) return true;
  return result.turnResults.some((turn) =>
    turn.governorRulesFired.some((rule) => rule === "governor:hard_stop"),
  );
}

export function buildHarnessScorecard(params: {
  lane: string;
  budgetEvaluation: RegressionBudgetEvaluation;
  regressionResults: ScenarioResult[];
  canaryResults?: ScenarioResult[];
  generatedAt?: string;
  canaryPrefix?: string;
  trajectoryRowCount?: number;
}): HarnessScorecard {
  const canaryPrefix = (params.canaryPrefix ?? "canary-").trim() || "canary-";
  const canaryFromPrefix = params.regressionResults.filter((row) => row.scenarioId.startsWith(canaryPrefix));
  const canaryResults = params.canaryResults ?? canaryFromPrefix;
  const canarySource: HarnessScorecard["integrity"]["canary_source"] = params.canaryResults ? "file" : "scenario_prefix";
  const canaryPassedCount = canaryResults.filter((row) => row.passed).length;
  const canaryFailed = canaryResults.filter((row) => !row.passed);
  const hardStopCount = canaryResults.filter(scenarioHasHardStop).length;
  const canaryScenarioCount = canaryResults.length;
  const canaryPassRate = round3(safeDiv(canaryPassedCount, canaryScenarioCount));
  const canaryAvgScore = round3(safeDiv(
    canaryResults.reduce((sum, row) => sum + row.score, 0),
    canaryScenarioCount,
  ));
  const canaryAvgTurns = round3(safeDiv(
    canaryResults.reduce((sum, row) => sum + row.totalTurns, 0),
    canaryScenarioCount,
  ));

  const reasons = [
    ...params.budgetEvaluation.violations.map((violation) =>
      `budget:${violation.metric}:${violation.direction}:${violation.delta}`,
    ),
    ...canaryFailed.map((row) => `canary_failure:${row.scenarioId}`),
    ...(hardStopCount > 0 ? [`canary_hard_stop_count:${hardStopCount}`] : []),
  ];

  return {
    schema_version: "harness_scorecard_v1",
    generated_at: params.generatedAt ?? new Date().toISOString(),
    lane: params.lane,
    metrics: {
      pass_rate: params.budgetEvaluation.candidate.passRate,
      avg_score: params.budgetEvaluation.candidate.avgScore,
      intervention_rate: params.budgetEvaluation.candidate.interventionRate,
      repeated_command_anomaly_rate: params.budgetEvaluation.candidate.repeatedCommandAnomalyRate,
      avg_turns_to_resolution: params.budgetEvaluation.candidate.avgTurnsToResolution,
      read_edit_ratio: params.budgetEvaluation.candidate.readEditRatio,
      whole_write_ratio: params.budgetEvaluation.candidate.wholeWriteRatio,
      premature_stop_signal_rate: params.budgetEvaluation.candidate.prematureStopSignalRate,
    },
    budget: {
      pass: params.budgetEvaluation.pass,
      violation_count: params.budgetEvaluation.violations.length,
      violations: params.budgetEvaluation.violations,
    },
    canary: {
      scenario_count: canaryScenarioCount,
      passed_count: canaryPassedCount,
      failed_count: canaryFailed.length,
      pass_rate: canaryPassRate,
      avg_score: canaryAvgScore,
      avg_turns: canaryAvgTurns,
      hard_stop_scenario_count: hardStopCount,
      failed_scenarios: canaryFailed.map((row) => row.scenarioId),
    },
    redline: {
      breached: reasons.length > 0,
      reasons,
    },
    integrity: {
      regression_scenario_count: params.regressionResults.length,
      trajectory_row_count: Math.max(0, Math.floor(params.trajectoryRowCount ?? 0)),
      canary_source: canarySource,
      canary_prefix: canaryPrefix,
    },
  };
}

function countConsecutiveRedlineBreaches(history: HarnessScorecardHistoryEntry[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!history[i]?.redline_breached) break;
    streak += 1;
  }
  return streak;
}

export function applyRollbackPolicy(params: {
  scorecard: HarnessScorecard;
  history: HarnessScorecardHistoryEntry[];
  breachThreshold: number;
  maxHistory?: number;
}): { decision: RollbackPolicyDecision; updatedHistory: HarnessScorecardHistoryEntry[] } {
  const threshold = Math.max(1, Math.floor(params.breachThreshold));
  const entry: HarnessScorecardHistoryEntry = {
    generated_at: params.scorecard.generated_at,
    lane: params.scorecard.lane,
    redline_breached: params.scorecard.redline.breached,
    redline_reasons: params.scorecard.redline.reasons,
    budget_pass: params.scorecard.budget.pass,
    canary_pass_rate: params.scorecard.canary.pass_rate,
  };

  const maxHistory = Math.max(1, Math.floor(params.maxHistory ?? 90));
  const updatedHistory = [...params.history, entry].slice(-maxHistory);
  const consecutiveRedlineBreaches = countConsecutiveRedlineBreaches(updatedHistory);
  const holdRollout = consecutiveRedlineBreaches >= threshold;

  const decision: RollbackPolicyDecision = holdRollout
    ? {
      action: "hold_rollout",
      hold_rollout: true,
      consecutive_redline_breaches: consecutiveRedlineBreaches,
      threshold,
      reason: `Red-line KPI breaches hit ${consecutiveRedlineBreaches} consecutive runs (threshold=${threshold}).`,
      suggested_actions: [
        "Freeze rollout lane.",
        "Revert most recent harness config/prompt change.",
        "Require explicit sign-off before re-enabling rollout.",
      ],
    }
    : {
      action: "proceed",
      hold_rollout: false,
      consecutive_redline_breaches: consecutiveRedlineBreaches,
      threshold,
      reason: params.scorecard.redline.breached
        ? `Red-line breach detected, but streak (${consecutiveRedlineBreaches}) is below threshold (${threshold}).`
        : "No red-line KPI breach detected.",
      suggested_actions: params.scorecard.redline.breached
        ? ["Track breach trend and prepare rollback if streak continues."]
        : ["Proceed with rollout lane checks."],
    };

  return { decision, updatedHistory };
}

export function renderHarnessScorecardMarkdown(
  scorecard: HarnessScorecard,
  decision?: RollbackPolicyDecision,
): string {
  const lines: string[] = [];
  lines.push("# Harness Scorecard");
  lines.push("");
  lines.push(`- Generated at: ${scorecard.generated_at}`);
  lines.push(`- Lane: ${scorecard.lane}`);
  lines.push(`- Red-line breached: ${scorecard.redline.breached ? "yes" : "no"}`);
  lines.push(`- Trajectory rows observed: ${scorecard.integrity.trajectory_row_count}`);
  lines.push("");
  lines.push("## KPIs");
  lines.push("");
  lines.push(`- pass_rate: ${scorecard.metrics.pass_rate}`);
  lines.push(`- avg_score: ${scorecard.metrics.avg_score}`);
  lines.push(`- intervention_rate: ${scorecard.metrics.intervention_rate}`);
  lines.push(`- repeated_command_anomaly_rate: ${scorecard.metrics.repeated_command_anomaly_rate}`);
  lines.push(`- avg_turns_to_resolution: ${scorecard.metrics.avg_turns_to_resolution}`);
  lines.push(`- read_edit_ratio: ${scorecard.metrics.read_edit_ratio}`);
  lines.push(`- whole_write_ratio: ${scorecard.metrics.whole_write_ratio}`);
  lines.push(`- premature_stop_signal_rate: ${scorecard.metrics.premature_stop_signal_rate}`);
  lines.push("");
  lines.push("## Budget");
  lines.push("");
  lines.push(`- pass: ${scorecard.budget.pass}`);
  lines.push(`- violation_count: ${scorecard.budget.violation_count}`);
  if (scorecard.budget.violations.length > 0) {
    lines.push("- violations:");
    for (const violation of scorecard.budget.violations) {
      lines.push(`  - ${violation.metric} (${violation.direction}) delta=${violation.delta} threshold=${violation.threshold}`);
    }
  }
  lines.push("");
  lines.push("## Power-User Canary");
  lines.push("");
  lines.push(`- scenario_count: ${scorecard.canary.scenario_count}`);
  lines.push(`- pass_rate: ${scorecard.canary.pass_rate}`);
  lines.push(`- avg_score: ${scorecard.canary.avg_score}`);
  lines.push(`- avg_turns: ${scorecard.canary.avg_turns}`);
  lines.push(`- hard_stop_scenario_count: ${scorecard.canary.hard_stop_scenario_count}`);
  if (scorecard.canary.failed_scenarios.length > 0) {
    lines.push(`- failed_scenarios: ${scorecard.canary.failed_scenarios.join(", ")}`);
  }
  lines.push("");
  lines.push("## Red-Line Reasons");
  lines.push("");
  if (scorecard.redline.reasons.length === 0) {
    lines.push("- none");
  } else {
    for (const reason of scorecard.redline.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  if (decision) {
    lines.push("");
    lines.push("## Rollback Decision");
    lines.push("");
    lines.push(`- action: ${decision.action}`);
    lines.push(`- hold_rollout: ${decision.hold_rollout}`);
    lines.push(`- consecutive_redline_breaches: ${decision.consecutive_redline_breaches}`);
    lines.push(`- threshold: ${decision.threshold}`);
    lines.push(`- reason: ${decision.reason}`);
    if (decision.suggested_actions.length > 0) {
      lines.push("- suggested_actions:");
      for (const step of decision.suggested_actions) {
        lines.push(`  - ${step}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}
