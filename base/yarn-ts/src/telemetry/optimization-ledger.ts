/**
 * Per-request record of token savings at each pipeline stage.
 *
 * Constructed at request start, accumulated through the pipeline, emitted as a
 * structured log line on every request. Feeds Prometheus histograms and
 * training-data materializer.
 */

const CHARS_PER_TOKEN = 4;

export type OptimizationStageName =
  | "ingress"
  | "normalization"
  | "pruning"
  | "context"
  | "governor"
  | "enrichment"
  | "provider_request"
  | "provider"
  | "stream"
  | "persistence"
  | (string & {});

export interface OptimizationCacheDiagnostics {
  policyAction?: string;
  policyProvider?: string;
  policyCompactionMode?: string;
  policyReasons?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  cacheStrategy?: string;
  prefixFingerprint?: string;
  messageCount?: number;
  stablePrefixHash?: string;
  stablePrefixBytes?: number;
  toolCount?: number;
  toolSchemaHash?: string;
  toolSchemaBytes?: number;
  providerOptionsHash?: string;
  providerOptionsBytes?: number;
  normalizedTranscriptPrefixHash?: string;
  normalizedTranscriptPrefixBytes?: number;
  cachePolicyHash?: string;
  cachePolicyBytes?: number;
  modelProviderResolutionHash?: string;
  modelProviderResolutionBytes?: number;
  cacheShapePromptTokens?: number;
  cacheShapeCachedTokens?: number;
  cacheShapeCacheCreationTokens?: number;
  cacheShapeHitPct?: number;
  cacheShapeOutcome?: "hit" | "write" | "miss" | "unknown";
}

export interface OptimizationLedgerSnapshot {
  inputCharsOriginal: number;
  inputCharsAfterReduction: number;
  inputCharsAfterPruning: number;
  inputCharsAfterDedup: number;
  inputCharsAfterNormalization: number;
  inputCharsFinal: number;

  toolResultsOriginalChars: number;
  toolResultsReducedChars: number;

  responseDedupHits: number;
  responseDedupMisses: number;
  blockStoreHits: number;
  blockStoreMisses: number;
  contentDedupHits: number;
  jitterLinesExtracted: number;
  historicalNormReplacements: number;
  toolIdRewrites: number;

  prefixStableBytes: number;
  upstreamCachedTokens: number;

  stageTimingsMs: Record<string, number>;
  cacheDiagnostics?: OptimizationCacheDiagnostics;

  estimatedTokensSaved: number;
  pipelineLatencyMs: number;
}

function charsOfMessages(messages: Array<{ content?: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else if (m.content != null) {
      total += JSON.stringify(m.content).length;
    }
  }
  return total;
}

export class OptimizationLedger {
  private startTime = Date.now();
  private data: OptimizationLedgerSnapshot = {
    inputCharsOriginal: 0,
    inputCharsAfterReduction: 0,
    inputCharsAfterPruning: 0,
    inputCharsAfterDedup: 0,
    inputCharsAfterNormalization: 0,
    inputCharsFinal: 0,

    toolResultsOriginalChars: 0,
    toolResultsReducedChars: 0,

    responseDedupHits: 0,
    responseDedupMisses: 0,
    blockStoreHits: 0,
    blockStoreMisses: 0,
    contentDedupHits: 0,
    jitterLinesExtracted: 0,
    historicalNormReplacements: 0,
    toolIdRewrites: 0,

    prefixStableBytes: 0,
    upstreamCachedTokens: 0,

    stageTimingsMs: {},

    estimatedTokensSaved: 0,
    pipelineLatencyMs: 0,
  };

  startStage(stage: OptimizationStageName, nowMs = Date.now()): () => void {
    let ended = false;
    return (endMs = Date.now()): void => {
      if (ended) return;
      ended = true;
      this.recordStageDuration(stage, Math.max(0, endMs - nowMs));
    };
  }

  recordStageDuration(stage: OptimizationStageName, durationMs: number): void {
    this.data.stageTimingsMs[stage] = (this.data.stageTimingsMs[stage] ?? 0) + Math.max(0, Math.round(durationMs));
  }

  recordOriginal(messages: Array<{ content?: unknown }>): void {
    this.data.inputCharsOriginal = charsOfMessages(messages);
  }

  recordAfterReduction(messages: Array<{ content?: unknown }>, toolCharsOriginal: number, toolCharsReduced: number): void {
    this.data.inputCharsAfterReduction = charsOfMessages(messages);
    this.data.toolResultsOriginalChars = toolCharsOriginal;
    this.data.toolResultsReducedChars = toolCharsReduced;
  }

  recordAfterPruning(messages: Array<{ content?: unknown }>): void {
    this.data.inputCharsAfterPruning = charsOfMessages(messages);
  }

  recordAfterDedup(messages: Array<{ content?: unknown }>, hits: number): void {
    this.data.inputCharsAfterDedup = charsOfMessages(messages);
    this.data.contentDedupHits += hits;
  }

  recordAfterNormalization(messages: Array<{ content?: unknown }>): void {
    this.data.inputCharsAfterNormalization = charsOfMessages(messages);
  }

  recordFinal(messages: Array<{ content?: unknown }>): void {
    this.data.inputCharsFinal = charsOfMessages(messages);
  }

  addResponseDedupHit(): void { this.data.responseDedupHits += 1; }
  addResponseDedupMiss(): void { this.data.responseDedupMisses += 1; }
  addBlockStoreHit(): void { this.data.blockStoreHits += 1; }
  addBlockStoreMiss(): void { this.data.blockStoreMisses += 1; }
  addJitterLines(count: number): void { this.data.jitterLinesExtracted += count; }
  addHistoricalNormReplacements(count: number): void { this.data.historicalNormReplacements += count; }
  addToolIdRewrites(count: number): void { this.data.toolIdRewrites += count; }
  setPrefixStableBytes(bytes: number): void { this.data.prefixStableBytes = bytes; }
  setUpstreamCachedTokens(tokens: number): void { this.data.upstreamCachedTokens = tokens; }
  recordCacheDiagnostics(diagnostics: OptimizationCacheDiagnostics): void {
    this.data.cacheDiagnostics = {
      ...this.data.cacheDiagnostics,
      ...diagnostics,
      policyReasons: diagnostics.policyReasons ?? this.data.cacheDiagnostics?.policyReasons,
      prefixChangeReasons: diagnostics.prefixChangeReasons ?? this.data.cacheDiagnostics?.prefixChangeReasons,
    };
  }

  finalize(): OptimizationLedgerSnapshot {
    this.data.pipelineLatencyMs = Date.now() - this.startTime;
    this.data.estimatedTokensSaved = Math.max(
      0,
      Math.ceil((this.data.inputCharsOriginal - this.data.inputCharsFinal) / CHARS_PER_TOKEN),
    );
    return { ...this.data };
  }

  /** Compact log-friendly object (drops zero-value fields for readability). */
  toLogRecord(): Record<string, unknown> {
    const snap = this.finalize();
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snap)) {
      if (typeof v === "number" && v !== 0) {
        record[k] = v;
      }
    }
    if (Object.keys(snap.stageTimingsMs).length > 0) {
      record.stageTimingsMs = snap.stageTimingsMs;
    }
    if (snap.cacheDiagnostics && Object.keys(snap.cacheDiagnostics).length > 0) {
      record.cacheDiagnostics = snap.cacheDiagnostics;
    }
    return record;
  }
}
