/**
 * Per-request record of token savings at each pipeline stage.
 *
 * Constructed at request start, accumulated through the pipeline, emitted as a
 * structured log line on every request. Feeds Prometheus histograms and
 * training-data materializer.
 */

const CHARS_PER_TOKEN = 4;

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

    estimatedTokensSaved: 0,
    pipelineLatencyMs: 0,
  };

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

  finalize(): OptimizationLedgerSnapshot {
    this.data.pipelineLatencyMs = Date.now() - this.startTime;
    this.data.estimatedTokensSaved = Math.max(
      0,
      Math.ceil((this.data.inputCharsOriginal - this.data.inputCharsFinal) / CHARS_PER_TOKEN),
    );
    return { ...this.data };
  }

  /** Compact log-friendly object (drops zero-value fields for readability). */
  toLogRecord(): Record<string, number> {
    const snap = this.finalize();
    const record: Record<string, number> = {};
    for (const [k, v] of Object.entries(snap)) {
      if (typeof v === "number" && v !== 0) {
        record[k] = v;
      }
    }
    return record;
  }
}
