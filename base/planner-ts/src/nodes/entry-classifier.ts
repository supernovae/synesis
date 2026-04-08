import type { CynefinDomain, GraphState } from "../state/types.js";
import {
  clampBudgetToTierCeiling,
  computeScaledCriticBudget,
  computeScaledWriterBudget,
  computeWriterEffectiveMaxTokens,
} from "../budgets.js";
import { loadConfig } from "../config.js";
import { resolveTierSettings } from "../model-tiers.js";
import { buildDomainProfile } from "./domain-profile.js";
import { getScoringEngine, initScoringEngineFromSnapshot, type ScoringResult } from "./scoring-engine.js";
import { getOntologySnapshot } from "../ontology/merge-plugins.js";
import { resolveTaxonomyMetadataAsync } from "../taxonomy/taxonomy-prompt-factory.js";
import { resolveActiveVertical } from "../taxonomy/vertical-prompts.js";
import { analyzeLiveWebIntent } from "./web-intent.js";

type EffortMode = "pulse" | "core" | "horizon";

function clip01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function recommendEffortMode(
  requested: GraphState["requested_effort_mode"],
  difficulty: number,
  riskScore: number,
  taxonomyComplexity: number,
): EffortMode {
  if (requested && requested !== "auto") return requested;
  const risk = clip01(riskScore / 100);
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
      critic_background: true,
    };
  }
  if (mode === "horizon") {
    return {
      critique_passes: 2,
      max_iterations: 4,
      critic_background: false,
    };
  }
  return {
    critique_passes: 1,
    max_iterations: 3,
    critic_background: criticBackgroundDefault,
  };
}

function isFollowUp(state: GraphState): boolean {
  const msgs = state.messages ?? [];
  const userMsgs = msgs.filter((m) => m.role === "user");
  if (userMsgs.length < 2) return false;
  return (state.task_description ?? "").trim().length < 80;
}

/**
 * Map difficulty, frame coherence, and taxonomy complexity to a Cynefin domain.
 * Clear: low difficulty, focused frame — obvious cause-effect.
 * Complicated: moderate difficulty, analysis needed but knowable.
 * Complex: high difficulty or composite frame — outcomes visible only in retrospect.
 * Chaotic: diffuse frame + high difficulty — no stable pattern, clarify first.
 */
function classifyCynefin(
  difficulty: number,
  frameCoherence: "focused" | "composite" | "diffuse",
  taxonomyComplexity: number,
): CynefinDomain {
  if (frameCoherence === "diffuse" && difficulty >= 0.55) return "chaotic";
  if (frameCoherence === "diffuse" && difficulty >= 0.4) return "complex";
  if (difficulty >= 0.6 || (frameCoherence === "composite" && taxonomyComplexity >= 0.6)) return "complex";
  if (difficulty >= 0.35 || taxonomyComplexity >= 0.5) return "complicated";
  return "clear";
}

function buildClassificationText(state: GraphState): string {
  const task = (state.task_description ?? "").trim();
  if (!isFollowUp(state)) return task.slice(0, 2500);
  const msgs = state.messages ?? [];
  const prior = msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => m.content.slice(0, 300))
    .join(" ");
  return (prior + " " + task).slice(0, 2500);
}

async function buildFullTaxonomy(scoring: ScoringResult, text: string): Promise<Record<string, unknown>> {
  const snap = getOntologySnapshot();

  // Initialize scoring engine from merged ontology on first call
  try { initScoringEngineFromSnapshot(snap); } catch { /* already initialized */ }

  // Resolve taxonomy metadata from YAML config (with optional semantic cross-check)
  const taxonomyMeta = await resolveTaxonomyMetadataAsync({
    activeDomainRefs: scoring.activeDomains,
    taskSize: scoring.taskSize,
    intentClass: scoring.intentClass,
    complexityScore: scoring.complexityScore,
    domainRefCounts: scoring.domainRefCounts,
    queryText: text,
  });

  // Resolve active vertical from merged plugin data
  const activeVertical = resolveActiveVertical(
    snap.verticalPrompts,
    scoring.activeDomains,
  );

  // Scoring-derived output_controls as baseline
  const scoringComplexity = clip01(scoring.complexityScore / 15);
  const scoringControls = {
    precise: scoringComplexity >= 0.6,
    show_assumptions: scoringComplexity >= 0.55,
    clarify_first: scoringComplexity >= 0.7,
  };

  // YAML output_controls override scoring defaults (matching Python merge)
  const yamlControls = (taxonomyMeta.output_controls ?? {}) as Record<string, boolean>;
  const mergedControls = { ...scoringControls, ...yamlControls };

  return {
    ...taxonomyMeta,
    intent_class: scoring.intentClass,
    domain_hints: scoring.domainHints,
    score_breakdown: scoring.scoreBreakdown,
    classification_hits: scoring.classificationHits,
    active_domains: scoring.activeDomains,
    domain_ref_counts: scoring.domainRefCounts,
    explicit_deliverables: scoring.explicitDeliverables,
    active_vertical: activeVertical,
    output_controls: mergedControls,
  };
}

export async function classifyEntry(
  state: GraphState,
  opts: { criticBackgroundDefault: boolean } = { criticBackgroundDefault: true },
): Promise<GraphState> {
  const text = buildClassificationText(state);
  const engine = getScoringEngine();
  const scoring = engine.analyze(text);

  const difficulty = scoring.difficulty;
  const taxonomy = await buildFullTaxonomy(scoring, text);
  const taxonomyComplexity = Number(taxonomy.complexity_score ?? 0.4);
  const riskScore = scoring.riskScore;
  const taskSize: GraphState["task_size"] = scoring.taskSize;

  const inputPlanRequired = state.plan_required === true;
  const planRequired =
    inputPlanRequired ||
    scoring.planSession ||
    difficulty >= scoring.routingThresholds.planRequiredAbove;
  const followUp = isFollowUp(state);
  const taskIsTrivialBase = !followUp && difficulty < scoring.routingThresholds.bypassSupervisorBelow;

  const liveWebIntent = analyzeLiveWebIntent(text);
  const forceLiveWeb = liveWebIntent.needsLiveWeb;
  let taskIsTrivial = taskIsTrivialBase;
  let ragMode: GraphState["rag_mode"] =
    difficulty < 0.2 ? "disabled" : difficulty < 0.45 ? "light" : "normal";
  if (inputPlanRequired && ragMode === "disabled") {
    ragMode = "light";
  }
  if (forceLiveWeb) {
    taskIsTrivial = false;
    if (ragMode === "disabled") {
      ragMode = "light";
    }
  }

  const selectedMode = recommendEffortMode(
    state.requested_effort_mode,
    difficulty,
    riskScore,
    taxonomyComplexity,
  );

  const cfg = loadConfig();
  const tierCaps = resolveTierSettings(state.requested_model);
  const tierWriterCeiling = state.writer_max_tokens ?? tierCaps.writerMaxTokens;
  const tierCriticCeiling = state.critic_max_tokens ?? tierCaps.criticMaxTokens;
  const scaledWriter = computeScaledWriterBudget(cfg, difficulty, taskIsTrivial);
  const scaledCritic = computeScaledCriticBudget(cfg, difficulty);
  const writerBudgetTargetBase = clampBudgetToTierCeiling(scaledWriter, tierWriterCeiling);
  const criticTokens = clampBudgetToTierCeiling(scaledCritic, tierCriticCeiling);

  const baseExecutionPolicy: Record<string, unknown> = {
    ...policyForEffort(selectedMode, opts.criticBackgroundDefault),
    scaled_writer_budget: writerBudgetTargetBase,
    scaled_critic_budget: criticTokens,
  };
  const inputPolicy =
    state.execution_policy && typeof state.execution_policy === "object" && !Array.isArray(state.execution_policy)
      ? (state.execution_policy as Record<string, unknown>)
      : {};
  const executionPolicy = { ...baseExecutionPolicy, ...inputPolicy };

  const mergedWriterTarget = Number(executionPolicy.scaled_writer_budget ?? writerBudgetTargetBase);
  const writerBudgetTarget = clampBudgetToTierCeiling(mergedWriterTarget, tierWriterCeiling);
  const writerMaxEffective = computeWriterEffectiveMaxTokens(cfg, writerBudgetTarget, tierWriterCeiling);
  const executionPolicyNormalized: Record<string, unknown> = {
    ...executionPolicy,
    scaled_writer_budget: writerBudgetTarget,
  };

  const useWriterFastPath =
    !inputPlanRequired && (taskIsTrivial || (ragMode === "disabled" && !planRequired));
  const nextNode: GraphState["next_node"] = useWriterFastPath ? "writer" : "planner";

  const domainProfile = state.domain_profile ?? buildDomainProfile(text);
  const cynefinDomain = classifyCynefin(difficulty, domainProfile.frameCoherence, taxonomyComplexity);

  const outputControls = (taxonomy.output_controls ?? {}) as Record<string, boolean>;
  const showAssumptions = Boolean(outputControls.show_assumptions) || difficulty >= 0.55;

  const styleContractLocked: Record<string, unknown> = {
    clarify_first: Boolean(outputControls.clarify_first),
    show_assumptions: showAssumptions,
    precise: Boolean(outputControls.precise),
    frame_coherence: domainProfile.frameCoherence,
  };

  return {
    ...state,
    difficulty,
    risk_score: riskScore,
    task_size: taskSize,
    plan_required: planRequired,
    task_is_trivial: taskIsTrivial,
    force_live_web: forceLiveWeb,
    rag_mode: ragMode,
    taxonomy_metadata: taxonomy,
    cynefin_domain: cynefinDomain,
    recommended_effort_mode: selectedMode,
    selected_effort_mode: selectedMode,
    execution_policy: executionPolicyNormalized,
    max_iterations: Number(executionPolicyNormalized.max_iterations ?? 3),
    writer_budget_target: writerBudgetTarget,
    writer_max_tokens: writerMaxEffective,
    critic_max_tokens: Number(executionPolicyNormalized.scaled_critic_budget ?? state.critic_max_tokens ?? cfg.SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE),
    domain_profile: domainProfile,
    show_assumptions: showAssumptions,
    style_contract_locked: styleContractLocked,
    next_node: nextNode,
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
