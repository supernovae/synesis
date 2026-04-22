export type {
  GapKind,
  EvidenceGap,
  GapClassification,
  ExplorationAction,
  ExplorationPlan,
  SensemakingResult,
  SensemakingStats,
  GapAnalysisContext,
} from "./types.js";
export { createEmptySensemakingStats } from "./types.js";
export { analyzeGaps, shouldTriggerSensemaking } from "./gap-analyzer.js";
export { buildExplorationPlan } from "./exploration-planner.js";
export { formatExplorationPlanBlock } from "./formatter.js";
export { runSensemaking, applySensemakingStats } from "./run-sensemaking.js";
