/**
 * Training Materializer — converts eval gym results into training data
 * formats compatible with the Synesis feedback loop export pipeline.
 *
 * Produces:
 *   - SFT examples: full conversation as (input, output) pairs
 *   - DPO preference pairs: governor intervention as preference signal
 *   - RLAIF reward examples: anomaly scores as reward signals
 *
 * Output is compatible with:
 *   - Admin feedback loop `GET /runs/{id}/dataset?dataset_type=eval_gym`
 *   - Direct JSONL export via `npm run eval:export`
 *   - Downstream trainers (Axolotl, TRL, custom)
 */

import type {
  ScenarioResult,
  TurnResult,
  EvalChatMessage,
  SftExample,
  DpoExample,
  RlaifExample,
  TrainingExample,
  TrainingFormat,
} from "./types.js";

// ---------------------------------------------------------------------------
// SFT materializer
// ---------------------------------------------------------------------------

function messageToSft(m: EvalChatMessage): { role: string; content: string } {
  return {
    role: m.role,
    content: typeof m.content === "string" ? m.content : "",
  };
}

export function materializeSft(result: ScenarioResult): SftExample[] {
  const examples: SftExample[] = [];

  for (const turn of result.turnResults) {
    if (turn.messages.length < 2) continue;

    const assistantMsgs = turn.messages.filter(m => m.role === "assistant");
    if (assistantMsgs.length === 0) continue;

    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    const isPositive = result.passed && turn.anomalies.filter(a => a.severity === "error").length === 0;

    examples.push({
      messages: turn.messages.map(messageToSft),
      source: "eval_gym",
      scenario_id: result.scenarioId,
      quality_label: isPositive ? "positive" : "negative",
    });
  }

  return examples;
}

// ---------------------------------------------------------------------------
// DPO materializer
//
// When the governor intervened, the model's actual output is "rejected"
// and the recovery guidance is "chosen".
// ---------------------------------------------------------------------------

export function materializeDpo(result: ScenarioResult): DpoExample[] {
  const examples: DpoExample[] = [];

  for (const turn of result.turnResults) {
    if (turn.governorRulesFired.length === 0) continue;
    const pauseRules = turn.governorRulesFired.filter(r => r !== "allow" && r !== "disabled");
    if (pauseRules.length === 0) continue;

    const assistantMsgs = turn.messages.filter(m => m.role === "assistant");
    if (assistantMsgs.length === 0) continue;

    const rejected = assistantMsgs.map(m => typeof m.content === "string" ? m.content : "").join("\n").trim();
    if (!rejected) continue;

    const promptMessages = turn.messages
      .filter(m => m.role === "user" || m.role === "system" || m.role === "tool")
      .map(messageToSft);

    const chosen = buildIdealResponse(pauseRules, turn);

    examples.push({
      prompt: promptMessages,
      chosen,
      rejected,
      source: "eval_gym",
      scenario_id: result.scenarioId,
    });
  }

  return examples;
}

function buildIdealResponse(rules: string[], turn: TurnResult): string {
  const parts: string[] = [];

  if (rules.includes("verification_stall_no_edit")) {
    parts.push("I notice I've been running verification commands without making changes. Let me identify the specific issue and make a code edit to fix it.");
  }
  if (rules.includes("exploration_stall_no_edit")) {
    parts.push("I have enough context from the plan. Let me start implementing the next task with a concrete code edit.");
  }
  if (rules.includes("verbal_intent_without_action")) {
    parts.push("Let me make the change now.");
  }
  if (rules.includes("no_test_files_repeat")) {
    parts.push("The test file doesn't exist yet. Let me create it.");
  }
  if (rules.includes("broad_discovery_repeat")) {
    parts.push("I've already found the relevant files. Let me make the edit.");
  }

  if (parts.length === 0) {
    parts.push("Let me take a concrete action based on the information I have.");
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// RLAIF materializer
//
// Anomaly counts become a negative reward signal; clean turns get positive.
// ---------------------------------------------------------------------------

export function materializeRlaif(result: ScenarioResult): RlaifExample[] {
  const examples: RlaifExample[] = [];

  for (const turn of result.turnResults) {
    if (turn.messages.length < 2) continue;

    const errorCount = turn.anomalies.filter(a => a.severity === "error").length;
    const warningCount = turn.anomalies.filter(a => a.severity === "warning").length;
    const governorPaused = turn.governorRulesFired.some(r => r !== "allow" && r !== "disabled");

    let reward = 1.0;
    reward -= errorCount * 0.3;
    reward -= warningCount * 0.1;
    if (governorPaused) reward -= 0.4;
    reward = Math.max(-1, Math.min(1, reward));

    examples.push({
      messages: turn.messages.map(messageToSft),
      reward: Number(reward.toFixed(3)),
      anomaly_count: turn.anomalies.length,
      source: "eval_gym",
      scenario_id: result.scenarioId,
    });
  }

  return examples;
}

// ---------------------------------------------------------------------------
// Unified materializer
// ---------------------------------------------------------------------------

export function materialize(
  results: ScenarioResult[],
  format: TrainingFormat,
): TrainingExample[] {
  const examples: TrainingExample[] = [];

  for (const result of results) {
    switch (format) {
      case "sft":
        examples.push(...materializeSft(result));
        break;
      case "dpo":
        examples.push(...materializeDpo(result));
        break;
      case "rlaif":
        examples.push(...materializeRlaif(result));
        break;
    }
  }

  return examples;
}

// ---------------------------------------------------------------------------
// JSONL serializer
// ---------------------------------------------------------------------------

export function toJsonl(examples: TrainingExample[]): string {
  return examples.map(e => JSON.stringify(e)).join("\n") + "\n";
}

function summarizeScenarioTransitionQuality(result: ScenarioResult): {
  label: "forward_progress" | "stalled" | "regressed";
  score: number;
  reasons: string[];
} {
  let score = result.passed ? 0.45 : -0.45;
  const reasons: string[] = [];

  if (result.passed) {
    reasons.push("scenario_passed");
  } else {
    reasons.push("scenario_failed");
  }

  if (result.totalAnomalies > 0) {
    score -= Math.min(0.4, result.totalAnomalies * 0.08);
    reasons.push("anomalies_present");
  } else {
    score += 0.08;
    reasons.push("no_anomalies");
  }

  if (result.governorInterventions > 0) {
    score -= Math.min(0.35, result.governorInterventions * 0.12);
    reasons.push("governor_interventions");
  } else {
    score += 0.12;
    reasons.push("no_governor_interventions");
  }

  if (result.totalToolRounds <= Math.max(1, result.totalTurns)) {
    score += 0.08;
    reasons.push("tool_rounds_controlled");
  } else if (result.totalToolRounds > result.totalTurns * 2) {
    score -= 0.12;
    reasons.push("tool_rounds_high");
  }

  if (!result.passed && result.failureReasons.some((reason) => /regress|stall|loop/i.test(reason))) {
    score -= 0.1;
    reasons.push("regression_or_stall_reason");
  }

  const boundedScore = Number(Math.max(-1, Math.min(1, score)).toFixed(3));
  const label = boundedScore >= 0.25
    ? "forward_progress"
    : boundedScore <= -0.35
      ? "regressed"
      : "stalled";
  return {
    label,
    score: boundedScore,
    reasons: Array.from(new Set(reasons)),
  };
}

// ---------------------------------------------------------------------------
// Scenario result → trajectory row (canonical format from
// qwen-stability-feedback-loop.md)
// ---------------------------------------------------------------------------

export function scenarioResultToTrajectoryRow(result: ScenarioResult): Record<string, unknown> {
  const transitionQuality = summarizeScenarioTransitionQuality(result);
  const toolSequence: string[] = [];
  for (const turn of result.turnResults) {
    for (const m of turn.messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          toolSequence.push(tc.function.name);
        }
      }
    }
  }

  return {
    task_id: `eval:${result.scenarioId}:${result.timestamp}`,
    session_id: `eval-gym-${result.scenarioId}`,
    model_id: result.model,
    runtime_profile: "balanced_completion",
    user_intent: result.category,
    trajectory_steps: result.turnResults.map((turn, i) => ({
      turn_index: i,
      tool_rounds: turn.toolRounds,
      tool_sequence: turn.messages
        .filter(m => m.role === "assistant" && m.tool_calls)
        .flatMap(m => m.tool_calls!.map(tc => tc.function.name)),
      anomaly_count: turn.anomalies.length,
      assertion_pass_rate: turn.assertionResults.length > 0
        ? turn.assertionResults.filter(a => a.passed).length / turn.assertionResults.length
        : 1.0,
      governor_rules: turn.governorRulesFired,
      latency_ms: turn.latencyMs,
    })),
    outcome: result.passed ? "completed" : "stalled",
    failure_tags: result.failureReasons.map(r => r.slice(0, 100)),
    strength_tags: result.passed ? ["clean_completion"] : [],
    quality_signals: {
      score: result.score,
      total_turns: result.totalTurns,
      total_tool_rounds: result.totalToolRounds,
      total_anomalies: result.totalAnomalies,
      governor_interventions: result.governorInterventions,
      duration_ms: result.durationMs,
    },
    governor: {
      interventions: result.governorInterventions,
      rules_fired: result.allGovernorRules,
    },
    training_signals: {
      governor_intervened: result.governorInterventions > 0,
      governor_rules: result.allGovernorRules,
      no_edit_evidence: result.turnResults.some(t =>
        t.anomalies.some(a => a.kind === "waffling_marker"),
      ),
      evidence_delta: result.passed ? "positive" : "stalled",
      state_transition_quality_label: transitionQuality.label,
      state_transition_quality_score: transitionQuality.score,
      state_transition_quality_reasons: transitionQuality.reasons,
    },
    gold_next_step: "",
  };
}
