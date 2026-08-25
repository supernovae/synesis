import type { ScenarioResult } from "./types.js";

export interface PairedAccuracyMetrics {
  completePairs: number;
  passedPairs: number;
  pairedAccuracy: number | null;
  incompletePairIds: string[];
}

/**
 * Measure controlled pairs as a single unit: a pair passes only when both its
 * should-act and should-abstain variants pass. Unpaired results are reported
 * separately and never inflate paired accuracy.
 */
export function computePairedAccuracy(results: ScenarioResult[]): PairedAccuracyMetrics {
  const grouped = new Map<string, Map<"act" | "abstain", ScenarioResult>>();
  for (const result of results) {
    if (!result.evaluationPair) continue;
    const variants = grouped.get(result.evaluationPair.id) ?? new Map();
    variants.set(result.evaluationPair.expectedDecision, result);
    grouped.set(result.evaluationPair.id, variants);
  }

  let completePairs = 0;
  let passedPairs = 0;
  const incompletePairIds: string[] = [];
  for (const [pairId, variants] of grouped) {
    const act = variants.get("act");
    const abstain = variants.get("abstain");
    if (!act || !abstain) {
      incompletePairIds.push(pairId);
      continue;
    }
    completePairs += 1;
    if (act.passed && abstain.passed) passedPairs += 1;
  }

  return {
    completePairs,
    passedPairs,
    pairedAccuracy: completePairs > 0 ? Number((passedPairs / completePairs).toFixed(3)) : null,
    incompletePairIds: incompletePairIds.sort(),
  };
}
