import type { FixRecipe } from "../language-packs/types.js";

export interface ResolvedFinding {
  errorFamily: string;
  recipe: FixRecipe | null;
  rootCause: string | undefined;
  action: string | undefined;
  file: string | undefined;
  message: string;
}

export interface RecallResolution {
  findings: ResolvedFinding[];
  confidence: number;
  language: string | undefined;
  deterministicAnswer: boolean;
}

export type RecallRouting = "bypass" | "enrich" | "passthrough";

export interface RecallDecision {
  routing: RecallRouting;
  resolution: RecallResolution | null;
  syntheticBlock: string | null;
  enrichmentBlock: string | null;
}

export interface RecallStats {
  bypassAttempts: number;
  bypassSuccesses: number;
  enrichAttempts: number;
  enrichSuccesses: number;
  passthroughCount: number;
  totalConfidenceSum: number;
  totalDecisions: number;
  recipeHitCount: number;
  recipeMissCount: number;
  tokensSavedEstimate: number;
  byLanguage: Record<string, { bypasses: number; enrichments: number; passthroughs: number }>;
}

export function createEmptyRecallStats(): RecallStats {
  return {
    bypassAttempts: 0,
    bypassSuccesses: 0,
    enrichAttempts: 0,
    enrichSuccesses: 0,
    passthroughCount: 0,
    totalConfidenceSum: 0,
    totalDecisions: 0,
    recipeHitCount: 0,
    recipeMissCount: 0,
    tokensSavedEstimate: 0,
    byLanguage: {},
  };
}
