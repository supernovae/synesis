/**
 * Extended Memory — shared types for structural index, memory store,
 * hierarchical summaries, and chunked evaluation.
 */

// ---------------------------------------------------------------------------
// Structural Index (Layer 1)
// ---------------------------------------------------------------------------

export type SymbolKind = "function" | "method" | "type" | "interface" | "class" | "const" | "variable" | "module";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface FileIndexEntry {
  path: string;
  language: string;
  lines: number;
  symbols: SymbolEntry[];
  imports: string[];
}

export interface StructuralIndex {
  projectRoot: string;
  language: string;
  generatedAt: number;
  contentHash: string;
  files: FileIndexEntry[];
  /** Cross-file reference counts for PageRank-style relevance. */
  symbolRefs: Record<string, number>;
}

export interface StructuralIndexStats {
  totalFiles: number;
  totalSymbols: number;
  totalImports: number;
  generationMs: number;
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Memory Store (Layer 2 tools: StoreObservation / RecallFindings)
// ---------------------------------------------------------------------------

export type MemoryScope = "session" | "project";

export interface StoredObservation {
  id: string;
  topic: string;
  finding: string;
  scope: MemoryScope;
  sessionKey: string;
  projectRoot: string;
  namespace?: string;
  createdAt: number;
}

export interface MemoryStoreStats {
  totalStored: number;
  totalRecalled: number;
  sessionEntries: number;
  projectEntries: number;
}

// ---------------------------------------------------------------------------
// Hierarchical Summaries (Layer 3)
// ---------------------------------------------------------------------------

export type SummaryLevel = "file" | "directory" | "project";

export interface FileSummary {
  path: string;
  level: SummaryLevel;
  summary: string;
  contentHash: string;
  language: string;
  symbolCount: number;
  lineCount: number;
  updatedAt: number;
}

export interface SummaryStoreStats {
  fileSummaries: number;
  directorySummaries: number;
  projectSummaries: number;
  cacheHits: number;
  cacheMisses: number;
}

// ---------------------------------------------------------------------------
// Chunked Evaluation (Layer 4)
// ---------------------------------------------------------------------------

export type EvalPhase = "index" | "map_features" | "synthesize";

export interface FeatureRequirement {
  id: string;
  description: string;
  relevantFiles?: string[];
}

export interface FeatureFinding {
  featureId: string;
  status: "implemented" | "partial" | "missing" | "unknown";
  evidence: string;
  relevantFiles: string[];
  confidence: number;
}

export interface ChunkedEvalPlan {
  requirements: FeatureRequirement[];
  currentPhase: EvalPhase;
  currentFeatureIndex: number;
  findings: FeatureFinding[];
  synthesisResult?: string;
}

export interface ChunkedEvalStats {
  evalsStarted: number;
  featuresEvaluated: number;
  synthesesCompleted: number;
  avgFindingsPerEval: number;
}
