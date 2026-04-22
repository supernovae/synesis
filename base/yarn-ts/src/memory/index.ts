export type {
  SymbolKind,
  SymbolEntry,
  FileIndexEntry,
  StructuralIndex,
  StructuralIndexStats,
  MemoryScope,
  StoredObservation,
  MemoryStoreStats,
  SummaryLevel,
  FileSummary,
  SummaryStoreStats,
  EvalPhase,
  FeatureRequirement,
  FeatureFinding,
  ChunkedEvalPlan,
  ChunkedEvalStats,
} from "./types.js";

export {
  buildStructuralIndex,
  renderStructuralMap,
  ProjectStructuralIndexService,
  type FileInput,
  type RenderOptions,
} from "./structural-index.js";

export { extractSymbols, detectLanguage } from "./extractors.js";

export { MemoryStore } from "./memory-store.js";

export {
  HierarchicalSummaryStore,
  createHierarchicalSummaryStore,
  generateFileSummary,
  generateDirectorySummary,
} from "./summary-store.js";

export {
  shouldChunkEval,
  extractRequirements,
  createEvalPlan,
  advancePhase,
  addFinding,
  generateEvalPhaseContext,
  formatEvalProgress,
  createEmptyChunkedEvalStats,
} from "./chunked-eval.js";

export {
  runGoDoc,
  parseGoDocOutput,
  buildGoDocIndex,
  renderGoDocMap,
} from "./go-doc-index.js";

export {
  MemoryGovernorTracker,
  evaluateMemoryRules,
  createEmptyMemorySignals,
  type MemoryGovernorSignals,
  type MemoryGovernorRuleResult,
} from "./governor-integration.js";

export {
  generateExtendedMemoryContext,
  type ContextInjectorInput,
  type InjectedContext,
} from "./context-injector.js";

export { IncrementalStructuralIndex } from "./incremental-index.js";
