/**
 * Server-side sensemaking: gap analysis, trigger rules, optional exploration plan block.
 * Opt-in via SYNESIS_YARN_SENSEMAKING_ENABLED (default off) — see README / CACHING.md.
 */

import type { AppConfig } from "../config.js";
import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../recall/types.js";
import type { VerificationLoopState } from "../verification/types.js";
import { analyzeGaps, shouldTriggerSensemaking } from "./gap-analyzer.js";
import { buildExplorationPlan } from "./exploration-planner.js";
import { formatExplorationPlanBlock } from "./formatter.js";
import type { GapAnalysisContext, SensemakingResult, SensemakingStats } from "./types.js";

export interface RunSensemakingInput {
  config: AppConfig;
  /** Messages to derive languages (same helper as main pipeline). */
  messages: Array<{ role: string; content: unknown }>;
  getLanguages: (messages: Array<{ role: string; content: unknown }>) => string[];
  orchestration: OrchestratorDecision;
  recallDecision: RecallDecision | null;
  verificationState: VerificationLoopState;
  /** True when a prefetch or pattern match produced evidence in this request. */
  evidencePrefetched: boolean;
  evidenceConfidence: number;
  evidenceAuthoritative: boolean | undefined;
  userText: string;
  workingFrameGoal: string | undefined;
  consecutiveFailedVerifications: number;
}

export function runSensemaking(
  input: RunSensemakingInput,
): { result: SensemakingResult; block: string; evaluated: boolean } {
  if (!input.config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    return {
      result: { triggered: false, gaps: { known: [], unknown: [], knowBetter: [] } },
      block: "",
      evaluated: false,
    };
  }

  const languages = input.getLanguages(input.messages);
  const ctx: GapAnalysisContext = {
    recallDecision: input.recallDecision,
    verificationState: input.verificationState,
    evidenceConfidence: input.evidenceConfidence,
    evidenceAuthoritative: input.evidenceAuthoritative,
    evidencePrefetched: input.evidencePrefetched,
    phase: input.orchestration.phase,
    decisionPath: input.orchestration.decisionPath,
    consecutiveFailedVerifications: input.consecutiveFailedVerifications,
    languages,
    userText: input.userText,
    workingFrameGoal: input.workingFrameGoal,
  };

  const gaps = analyzeGaps(ctx);
  const { trigger, reason } = shouldTriggerSensemaking(
    gaps,
    input.orchestration,
    input.consecutiveFailedVerifications,
    input.config.SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD,
    input.config.SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY,
  );

  if (!trigger) {
    return {
      result: { triggered: false, gaps, reason: reason ?? undefined },
      block: "",
      evaluated: true,
    };
  }

  const plan = buildExplorationPlan(gaps, ctx);
  const result: SensemakingResult = { triggered: true, reason, gaps, plan };
  const block = formatExplorationPlanBlock(result);
  return { result, block, evaluated: true };
}

export function applySensemakingStats(
  stats: SensemakingStats,
  result: SensemakingResult,
  evaluated: boolean,
): void {
  if (!evaluated) return;
  const g = result.gaps;
  stats.knownCount += g.known.length;
  stats.unknownCount += g.unknown.length;
  stats.knowBetterCount += g.knowBetter.length;
  stats.totalGapsClassified += g.known.length + g.unknown.length + g.knowBetter.length;

  if (result.triggered) {
    stats.triggeredCount += 1;
    const r = result.reason ?? "unknown";
    stats.byReason[r] = (stats.byReason[r] ?? 0) + 1;
    if (result.plan) {
      stats.plansGenerated += 1;
      stats.actionsGenerated += result.plan.forwardPath.length;
    }
  } else {
    stats.skippedCount += 1;
  }
}
