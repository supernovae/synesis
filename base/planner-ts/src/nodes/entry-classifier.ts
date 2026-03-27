import type { GraphState } from "../state/types.js";

type EffortMode = "pulse" | "core" | "horizon";

const RISK_RE = /\b(prod(?:uction)?|security|compliance|hipaa|pci|pii|outage|migration|rollback)\b/i;
const CODE_RE = /\b(code|snippet|typescript|javascript|python|css|html|react|function|class)\b/i;
const TAXONOMY_PATTERNS: Array<{ key: string; re: RegExp; complexity: number }> = [
  { key: "web_frontend", re: /\b(html|css|react|vue|frontend|ui|sticky header)\b/i, complexity: 0.35 },
  { key: "cloud", re: /\b(kubernetes|k8s|aws|gcp|azure|infra|cluster|docker)\b/i, complexity: 0.65 },
  { key: "software_architecture", re: /\b(architecture|design|microservice|system design)\b/i, complexity: 0.7 },
  { key: "ml_ops", re: /\b(model|embedding|rag|inference|token budget|latency)\b/i, complexity: 0.75 }
];

function clip01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function detectDifficulty(text: string): number {
  const lenScore = clip01(text.length / 900);
  const questionCount = (text.match(/\?/g) ?? []).length;
  const questionScore = clip01(questionCount / 4);
  const listScore = clip01((text.match(/[,;:]/g) ?? []).length / 12);
  const riskBoost = RISK_RE.test(text) ? 0.15 : 0;
  const codeBoost = CODE_RE.test(text) ? 0.08 : 0;
  return clip01((lenScore * 0.45) + (questionScore * 0.25) + (listScore * 0.2) + riskBoost + codeBoost);
}

function detectTaxonomy(text: string): Record<string, unknown> {
  const hit = TAXONOMY_PATTERNS.find((item) => item.re.test(text));
  if (!hit) {
    return {
      taxonomy_key: "generic",
      complexity_score: 0.4,
      output_controls: { precise: false, show_assumptions: false, clarify_first: false }
    };
  }
  return {
    taxonomy_key: hit.key,
    complexity_score: hit.complexity,
    output_controls: {
      precise: hit.complexity >= 0.6,
      show_assumptions: hit.complexity >= 0.55,
      clarify_first: hit.complexity >= 0.7
    }
  };
}

function recommendEffortMode(
  requested: GraphState["requested_effort_mode"],
  difficulty: number,
  riskScore: number,
  taxonomyComplexity: number
): EffortMode {
  if (requested && requested !== "auto") return requested;
  const risk = riskScore / 100;
  const horizonScore = (difficulty * 0.45) + (risk * 0.35) + (taxonomyComplexity * 0.2);
  const pulseScore = ((1 - difficulty) * 0.55) + ((1 - risk) * 0.3) + ((1 - taxonomyComplexity) * 0.15);
  if (horizonScore >= 0.62) return "horizon";
  if (pulseScore >= 0.62) return "pulse";
  return "core";
}

function policyForEffort(mode: EffortMode, criticBackgroundDefault: boolean): Record<string, unknown> {
  if (mode === "pulse") {
    return {
      critique_passes: 0,
      max_iterations: 1,
      critic_background: true
    };
  }
  if (mode === "horizon") {
    return {
      critique_passes: 2,
      max_iterations: 4,
      critic_background: false
    };
  }
  return {
    critique_passes: 1,
    max_iterations: 3,
    critic_background: criticBackgroundDefault
  };
}

export function classifyEntry(
  state: GraphState,
  opts: { criticBackgroundDefault: boolean } = { criticBackgroundDefault: true }
): GraphState {
  const task = (state.task_description ?? "").trim();
  const text = task.slice(0, 2500);
  const difficulty = detectDifficulty(text);
  const taxonomy = detectTaxonomy(text);
  const riskScore = RISK_RE.test(text) ? 70 : 25;
  const taskSize: GraphState["task_size"] =
    difficulty < 0.2 ? "easy" : difficulty < 0.55 ? "medium" : "hard";
  const inputPlanRequired = state.plan_required === true;
  const planRequired = inputPlanRequired ? true : difficulty >= 0.45;
  const taskIsTrivial = difficulty < 0.15;
  let ragMode: GraphState["rag_mode"] = difficulty < 0.2 ? "disabled" : difficulty < 0.45 ? "light" : "normal";
  if (inputPlanRequired && ragMode === "disabled") {
    ragMode = "light";
  }
  const selectedMode = recommendEffortMode(
    state.requested_effort_mode,
    difficulty,
    riskScore,
    Number(taxonomy.complexity_score ?? 0.4)
  );
  const baseExecutionPolicy: Record<string, unknown> = {
    ...policyForEffort(selectedMode, opts.criticBackgroundDefault),
    scaled_writer_budget: taskIsTrivial ? 768 : Math.round(1200 + (difficulty * 2600)),
    scaled_critic_budget: Math.round(800 + (difficulty * 1200))
  };
  const inputPolicy =
    state.execution_policy && typeof state.execution_policy === "object" && !Array.isArray(state.execution_policy)
      ? (state.execution_policy as Record<string, unknown>)
      : {};
  const executionPolicy = { ...baseExecutionPolicy, ...inputPolicy };
  const policyRecord = executionPolicy;
  const useWriterFastPath =
    !inputPlanRequired && (taskIsTrivial || (ragMode === "disabled" && !planRequired));
  const nextNode: GraphState["next_node"] = useWriterFastPath ? "writer" : "planner";

  return {
    ...state,
    difficulty,
    risk_score: riskScore,
    task_size: taskSize,
    plan_required: planRequired,
    task_is_trivial: taskIsTrivial,
    rag_mode: ragMode,
    taxonomy_metadata: taxonomy,
    recommended_effort_mode: selectedMode,
    selected_effort_mode: selectedMode,
    execution_policy: executionPolicy,
    max_iterations: Number(policyRecord.max_iterations ?? 3),
    writer_max_tokens: Number(policyRecord.scaled_writer_budget ?? state.writer_max_tokens ?? 1800),
    critic_max_tokens: Number(policyRecord.scaled_critic_budget ?? state.critic_max_tokens ?? 1200),
    next_node: nextNode
  };
}

export function shouldRunInlineCritic(state: GraphState, criticSkipBelowDifficulty: number): boolean {
  const background = Boolean((state.execution_policy ?? {}).critic_background);
  const difficulty = Number(state.difficulty ?? 0.5);
  if (difficulty < criticSkipBelowDifficulty) return false;
  return !background;
}

export function deriveResponsePlan(state: GraphState): string {
  if (state.task_is_trivial) return "fast_path_trivial";
  if ((state.execution_policy ?? {}).critic_background) return "background_critic";
  return "inline_critic";
}
