/**
 * Diff Accumulator — Proportionality Governance Layer 2
 *
 * Tracks cumulative change magnitude across a session turn to detect
 * disproportionate agent actions (e.g., deleting features when asked
 * to fix security issues).
 *
 * Updated after each governed tool call with parsed edit metrics.
 * Compared against scope-envelope thresholds to trigger governance signals.
 */

import type { ScopeEnvelope, ScopeThresholds } from "./intent-scope-classifier.js";
import { getScopeThresholds } from "./intent-scope-classifier.js";

export interface DiffStats {
  filesCreated: number;
  filesDeleted: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  /** Positive = net deletion, negative = net addition. */
  netLinesRemoved: number;
  totalLinesChanged: number;
  largestSingleDeletion: { path: string; linesRemoved: number } | null;
  /** Distinct paths touched by edit/write operations. */
  touchedPaths: Set<string>;
}

export type ProportionalityLevel = "proportional" | "elevated" | "disproportionate" | "dangerous";

export interface ProportionalityAssessment {
  level: ProportionalityLevel;
  breaches: string[];
  stats: Readonly<DiffStats>;
  thresholds: ScopeThresholds | null;
}

export function createDiffStats(): DiffStats {
  return {
    filesCreated: 0,
    filesDeleted: 0,
    filesModified: 0,
    linesAdded: 0,
    linesRemoved: 0,
    netLinesRemoved: 0,
    totalLinesChanged: 0,
    largestSingleDeletion: null,
    touchedPaths: new Set(),
  };
}

/**
 * Record an edit/write operation in the accumulator.
 */
export function recordEditOperation(
  stats: DiffStats,
  path: string,
  linesAdded: number,
  linesRemoved: number,
): void {
  if (!stats.touchedPaths.has(path)) {
    stats.filesModified += 1;
    stats.touchedPaths.add(path);
  }
  stats.linesAdded += linesAdded;
  stats.linesRemoved += linesRemoved;
  stats.netLinesRemoved = stats.linesRemoved - stats.linesAdded;
  stats.totalLinesChanged = stats.linesAdded + stats.linesRemoved;

  if (
    linesRemoved > 0
    && (!stats.largestSingleDeletion || linesRemoved > stats.largestSingleDeletion.linesRemoved)
  ) {
    stats.largestSingleDeletion = { path, linesRemoved };
  }
}

/**
 * Record a file creation.
 */
export function recordFileCreated(stats: DiffStats, path: string): void {
  stats.filesCreated += 1;
  stats.touchedPaths.add(path);
}

/**
 * Record a file deletion (entire file removed or emptied).
 */
export function recordFileDeletion(stats: DiffStats, path: string, linesRemoved: number): void {
  stats.filesDeleted += 1;
  stats.linesRemoved += linesRemoved;
  stats.netLinesRemoved = stats.linesRemoved - stats.linesAdded;
  stats.totalLinesChanged = stats.linesAdded + stats.linesRemoved;
  stats.touchedPaths.add(path);

  if (!stats.largestSingleDeletion || linesRemoved > stats.largestSingleDeletion.linesRemoved) {
    stats.largestSingleDeletion = { path, linesRemoved };
  }
}

/**
 * Parse lines-added/removed from normalized tool result text.
 *
 * Handles common patterns from IDE tool results:
 *   "added 5 line(s)"
 *   "removed 12 line(s)"
 *   "5 insertions(+), 3 deletions(-)"  (git diff --stat)
 *   "+15 -8" (compact diff summary)
 */
export function parseEditMetrics(resultText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  const addedMatch = resultText.match(/added\s+(\d+)\s+line/i);
  if (addedMatch) added += parseInt(addedMatch[1], 10);

  const removedMatch = resultText.match(/removed\s+(\d+)\s+line/i);
  if (removedMatch) removed += parseInt(removedMatch[1], 10);

  const gitStatMatch = resultText.match(/(\d+)\s+insertion[s]?\(\+\)(?:.*?(\d+)\s+deletion[s]?\(-\))?/);
  if (gitStatMatch) {
    added += parseInt(gitStatMatch[1], 10);
    if (gitStatMatch[2]) removed += parseInt(gitStatMatch[2], 10);
  }

  const compactMatch = resultText.match(/\+(\d+)\s+-(\d+)/);
  if (compactMatch && !gitStatMatch && !addedMatch) {
    added += parseInt(compactMatch[1], 10);
    removed += parseInt(compactMatch[2], 10);
  }

  return { added, removed };
}

/**
 * Detect if a Write tool call represents a file deletion (empty or near-empty content).
 */
export function isFileDeletion(content: string | undefined | null): boolean {
  if (content === undefined || content === null) return true;
  return content.trim().length === 0;
}

/**
 * Assess whether the accumulated diff stats are proportional to the
 * user's declared scope envelope.
 */
export function assessProportionality(
  stats: Readonly<DiffStats>,
  envelope: ScopeEnvelope,
): ProportionalityAssessment {
  const thresholds = getScopeThresholds(envelope);

  if (!thresholds) {
    return { level: "proportional", breaches: [], stats, thresholds: null };
  }

  const breaches: string[] = [];

  if (stats.filesModified > thresholds.maxFilesModified) {
    breaches.push(`files_modified: ${stats.filesModified} > ${thresholds.maxFilesModified}`);
  }
  if (stats.netLinesRemoved > thresholds.maxNetLinesRemoved) {
    breaches.push(`net_lines_removed: ${stats.netLinesRemoved} > ${thresholds.maxNetLinesRemoved}`);
  }
  if (stats.filesDeleted > thresholds.maxFilesDeleted) {
    breaches.push(`files_deleted: ${stats.filesDeleted} > ${thresholds.maxFilesDeleted}`);
  }

  if (breaches.length === 0) {
    return { level: "proportional", breaches, stats, thresholds };
  }

  // Single breach = elevated, multiple = disproportionate
  // File deletion when scope is narrow_fix = dangerous
  if (envelope === "narrow_fix" && stats.filesDeleted > 0) {
    return { level: "dangerous", breaches, stats, thresholds };
  }
  if (breaches.length >= 2 || stats.netLinesRemoved > thresholds.maxNetLinesRemoved * 3) {
    return { level: "dangerous", breaches, stats, thresholds };
  }
  if (breaches.length === 1 && stats.filesModified > thresholds.maxFilesModified * 2) {
    return { level: "disproportionate", breaches, stats, thresholds };
  }

  return { level: "elevated", breaches, stats, thresholds };
}

/**
 * Map a proportionality assessment to a sensemaking signal name.
 */
export function proportionalityToSignal(level: ProportionalityLevel): string | null {
  switch (level) {
    case "elevated": return "scope_exceeded_narrow";
    case "disproportionate": return "scope_exceeded_moderate";
    case "dangerous": return "scope_exceeded_dangerous";
    default: return null;
  }
}
