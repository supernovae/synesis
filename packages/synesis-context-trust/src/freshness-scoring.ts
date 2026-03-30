/**
 * Freshness scoring utilities for retrieval ranking.
 *
 * Shared across planner-ts, admin, and future Yarn MCP retrieval paths.
 * Freshness is a soft preference signal — it never overrides trust or
 * safety constraints (flagged/rejected content is never boosted).
 */

const ONE_DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * Compute a freshness score (0.0–1.0) from a millisecond timestamp.
 * Uses exponential decay: score = exp(-0.693 * age_days / half_life_days).
 * Returns 0 for unknown timestamps (zero/negative/missing).
 */
export function freshnessScore(
  epochMs: number,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (!epochMs || epochMs <= 0) return 0;
  const ageDays = Math.max(0, (Date.now() - epochMs) / ONE_DAY_MS);
  return Math.exp((-0.693 * ageDays) / halfLifeDays);
}

/**
 * Minimal shape needed for freshness boosting — any retrieval result that
 * carries a score and optional trust/timestamp fields can be boosted.
 */
export interface FreshnessBoostable {
  score: number;
  scan_status?: string;
  approval_status?: string;
  effective_at_epoch?: number;
  crawl_timestamp?: number;
}

/**
 * Apply a freshness boost to retrieval results.
 *
 * `effectiveWeight` controls how much freshness influences the final score.
 * Hard constraints: never boost flagged/rejected content regardless of recency.
 *
 * Returns new array with updated scores (does not mutate input).
 */
export function freshnessBoost<T extends FreshnessBoostable>(
  results: T[],
  effectiveWeight = 0.1,
): T[] {
  if (effectiveWeight <= 0) return results;

  return results.map((r) => {
    if (r.scan_status === "flagged" || r.approval_status === "rejected")
      return r;
    const ts = (r.effective_at_epoch ?? r.crawl_timestamp ?? 0) * 1000;
    const fresh = freshnessScore(ts);
    if (fresh <= 0) return r;
    const boosted = r.score * (1 + effectiveWeight * fresh);
    return { ...r, score: boosted };
  });
}

/** Default half-life in days for freshness decay. */
export const FRESHNESS_HALF_LIFE_DAYS = DEFAULT_HALF_LIFE_DAYS;
