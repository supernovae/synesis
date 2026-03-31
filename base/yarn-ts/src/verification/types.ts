import type { EnrichedItem } from "../reduction/types.js";

export interface PlannedVerification {
  tool: string;
  command: string;
  description: string;
  priority: "required" | "recommended";
}

export interface VerificationPlan {
  languages: string[];
  commands: PlannedVerification[];
  maxRounds: number;
  budgetMs: number;
}

export interface VerificationRoundResult {
  round: number;
  command: string;
  findingCount: number;
  resolvedCount: number;
  bypassEligible: boolean;
  timestampMs: number;
}

export interface VerificationLoopState {
  round: number;
  findings: EnrichedItem[];
  allResolved: boolean;
  stalled: boolean;
  budgetExhausted: boolean;
  history: VerificationRoundResult[];
}

export interface VerificationStats {
  loopsStarted: number;
  loopsCompleted: number;
  totalRounds: number;
  totalFindingsDetected: number;
  totalFindingsResolved: number;
  selfRepairSuggestions: number;
  stallCount: number;
  budgetExhaustions: number;
  byLanguage: Record<string, { loops: number; rounds: number; resolved: number }>;
}

export function createEmptyVerificationStats(): VerificationStats {
  return {
    loopsStarted: 0,
    loopsCompleted: 0,
    totalRounds: 0,
    totalFindingsDetected: 0,
    totalFindingsResolved: 0,
    selfRepairSuggestions: 0,
    stallCount: 0,
    budgetExhaustions: 0,
    byLanguage: {},
  };
}
