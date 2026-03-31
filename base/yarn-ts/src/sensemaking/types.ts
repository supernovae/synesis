/**
 * Sensemaking and Exploration Engine types.
 *
 * Implements the Known / Unknown / KnowBetter framework from M11 theory,
 * structured exploration plans with future-backward reasoning, and
 * telemetry counters for the sensemaking subsystem.
 */

import type { DecisionPath, WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";
import type { RecallDecision } from "../recall/types.js";
import type { VerificationLoopState } from "../verification/types.js";

export type GapKind = "known" | "unknown" | "know_better";

export interface EvidenceGap {
  kind: GapKind;
  domain: string;
  description: string;
  suggestedAction: string;
}

export interface GapClassification {
  known: EvidenceGap[];
  unknown: EvidenceGap[];
  knowBetter: EvidenceGap[];
}

export interface ExplorationAction {
  kind: "tool" | "question" | "search";
  tool?: string;
  description: string;
  priority: "required" | "recommended";
}

export interface ExplorationPlan {
  desiredEndState: string;
  preconditions: string[];
  evidenceCheckpoints: string[];
  forwardPath: ExplorationAction[];
  fallbackBranches: string[];
}

export interface SensemakingResult {
  triggered: boolean;
  reason?: string;
  gaps: GapClassification;
  plan?: ExplorationPlan;
}

export interface SensemakingStats {
  triggeredCount: number;
  skippedCount: number;
  byReason: Record<string, number>;
  totalGapsClassified: number;
  knownCount: number;
  unknownCount: number;
  knowBetterCount: number;
  plansGenerated: number;
  actionsGenerated: number;
}

export function createEmptySensemakingStats(): SensemakingStats {
  return {
    triggeredCount: 0,
    skippedCount: 0,
    byReason: {},
    totalGapsClassified: 0,
    knownCount: 0,
    unknownCount: 0,
    knowBetterCount: 0,
    plansGenerated: 0,
    actionsGenerated: 0,
  };
}

export interface GapAnalysisContext {
  recallDecision: RecallDecision | null;
  verificationState: VerificationLoopState;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  evidencePrefetched?: boolean;
  phase: WorkflowPhase;
  decisionPath: DecisionPath;
  consecutiveFailedVerifications: number;
  languages: string[];
  userText: string;
  workingFrameGoal?: string;
}
