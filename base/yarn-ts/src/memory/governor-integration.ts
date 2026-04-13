/**
 * Governor integration for the extended memory layer.
 *
 * Detects patterns where the model should use memory tools instead of
 * re-reading files or running broad discovery, and provides signals
 * to the execution governor for rule evaluation.
 */

import type { StructuralIndex } from "./types.js";
import type { StoredObservation } from "./types.js";

// ---------------------------------------------------------------------------
// Signals the governor can evaluate
// ---------------------------------------------------------------------------

export interface MemoryGovernorSignals {
  structuralIndexAvailable: boolean;
  summaryHitRate: number;
  findingsStoreSize: number;
  rereadWithSummaryAvailable: number;
  broadDiscoveryWithoutIndex: number;
  findingsNotStored: number;
}

export function createEmptyMemorySignals(): MemoryGovernorSignals {
  return {
    structuralIndexAvailable: false,
    summaryHitRate: 0,
    findingsStoreSize: 0,
    rereadWithSummaryAvailable: 0,
    broadDiscoveryWithoutIndex: 0,
    findingsNotStored: 0,
  };
}

// ---------------------------------------------------------------------------
// Tracker — accumulates signals across a session
// ---------------------------------------------------------------------------

export class MemoryGovernorTracker {
  private indexAvailable = false;
  private summaryHits = 0;
  private summaryMisses = 0;
  private findingsCount = 0;
  private rereadWithSummary = 0;
  private broadDiscoveryWithoutIndex = 0;
  private findingsNotStored = 0;
  private readonly readPaths = new Set<string>();
  private readonly summarizedPaths = new Set<string>();

  setIndexAvailable(available: boolean): void {
    this.indexAvailable = available;
  }

  setFindingsCount(count: number): void {
    this.findingsCount = count;
  }

  /**
   * Track a file read. If a summary exists for this path, count as a
   * potential reread-with-summary-available.
   */
  trackFileRead(filePath: string): void {
    if (this.readPaths.has(filePath) && this.summarizedPaths.has(filePath)) {
      this.rereadWithSummary += 1;
    }
    this.readPaths.add(filePath);
  }

  trackSummaryGenerated(filePath: string): void {
    this.summarizedPaths.add(filePath);
    this.summaryHits += 1;
  }

  trackSummaryMiss(): void {
    this.summaryMisses += 1;
  }

  /**
   * Track a broad search/read command when an index is available.
   * The governor can suggest using the index instead.
   */
  trackBroadDiscovery(): void {
    if (this.indexAvailable) {
      this.broadDiscoveryWithoutIndex += 1;
    }
  }

  /**
   * Track when the model produces findings in text but doesn't call
   * StoreObservation.
   */
  trackUnstoreFinding(): void {
    this.findingsNotStored += 1;
  }

  getSignals(): MemoryGovernorSignals {
    const totalSummaryAttempts = this.summaryHits + this.summaryMisses;
    return {
      structuralIndexAvailable: this.indexAvailable,
      summaryHitRate: totalSummaryAttempts > 0 ? this.summaryHits / totalSummaryAttempts : 0,
      findingsStoreSize: this.findingsCount,
      rereadWithSummaryAvailable: this.rereadWithSummary,
      broadDiscoveryWithoutIndex: this.broadDiscoveryWithoutIndex,
      findingsNotStored: this.findingsNotStored,
    };
  }

  reset(): void {
    this.indexAvailable = false;
    this.summaryHits = 0;
    this.summaryMisses = 0;
    this.findingsCount = 0;
    this.rereadWithSummary = 0;
    this.broadDiscoveryWithoutIndex = 0;
    this.findingsNotStored = 0;
    this.readPaths.clear();
    this.summarizedPaths.clear();
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation helpers (used by execution-governor.ts)
// ---------------------------------------------------------------------------

export interface MemoryGovernorRuleResult {
  rule: string;
  fired: boolean;
  message: string;
}

export function evaluateMemoryRules(
  signals: MemoryGovernorSignals,
): MemoryGovernorRuleResult[] {
  const results: MemoryGovernorRuleResult[] = [];

  if (signals.rereadWithSummaryAvailable >= 2) {
    results.push({
      rule: "reread_with_summary",
      fired: true,
      message: `You have re-read ${signals.rereadWithSummaryAvailable} files that already have summaries in memory. Use QueryProjectMemory to retrieve summaries instead of re-reading full file contents.`,
    });
  }

  if (signals.broadDiscoveryWithoutIndex >= 5) {
    results.push({
      rule: "discovery_without_index",
      fired: true,
      message: `You have run ${signals.broadDiscoveryWithoutIndex} broad search/read commands. A structural index is available — consult it to narrow your search instead of reading files sequentially.`,
    });
  }

  if (signals.findingsNotStored >= 3) {
    results.push({
      rule: "findings_not_stored",
      fired: true,
      message: `You have produced ${signals.findingsNotStored} evaluation findings in your responses but never called StoreObservation. Store your findings so they persist across context resets and can be recalled later.`,
    });
  }

  return results;
}
