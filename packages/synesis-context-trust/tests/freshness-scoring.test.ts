import { describe, it, expect } from "vitest";
import {
  freshnessScore,
  freshnessBoost,
  FRESHNESS_HALF_LIFE_DAYS,
  type FreshnessBoostable,
} from "../src/freshness-scoring.js";

function makeItem(overrides: Partial<FreshnessBoostable> = {}): FreshnessBoostable {
  return { score: 1.0, ...overrides };
}

describe("freshnessScore", () => {
  it("returns 0 for missing/zero timestamps", () => {
    expect(freshnessScore(0)).toBe(0);
    expect(freshnessScore(-1)).toBe(0);
  });

  it("returns ~1.0 for a very recent timestamp", () => {
    const score = freshnessScore(Date.now() - 1000);
    expect(score).toBeGreaterThan(0.99);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("returns ~0.5 at the default half-life (90 days)", () => {
    const ninetyDaysAgo = Date.now() - FRESHNESS_HALF_LIFE_DAYS * 86_400_000;
    const score = freshnessScore(ninetyDaysAgo);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it("decays toward zero for very old timestamps", () => {
    const threeYearsAgo = Date.now() - 365 * 3 * 86_400_000;
    expect(freshnessScore(threeYearsAgo)).toBeLessThan(0.001);
  });

  it("respects custom half-life", () => {
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    expect(freshnessScore(thirtyDaysAgo, 30)).toBeCloseTo(0.5, 1);
    expect(freshnessScore(thirtyDaysAgo, 180)).toBeGreaterThan(0.85);
  });
});

describe("freshnessBoost", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("returns results unchanged when weight is 0", () => {
    const items = [makeItem({ score: 0.8 })];
    expect(freshnessBoost(items, 0)[0].score).toBe(0.8);
  });

  it("boosts recent results", () => {
    const items = [makeItem({ score: 0.8, effective_at_epoch: nowSec - 60 })];
    expect(freshnessBoost(items, 0.1)[0].score).toBeGreaterThan(0.8);
  });

  it("does not boost results without timestamps", () => {
    const items = [makeItem({ score: 0.8 })];
    expect(freshnessBoost(items, 0.1)[0].score).toBe(0.8);
  });

  it("does not boost flagged content", () => {
    const items = [
      makeItem({ score: 0.8, effective_at_epoch: nowSec - 60, scan_status: "flagged" }),
    ];
    expect(freshnessBoost(items, 0.1)[0].score).toBe(0.8);
  });

  it("does not boost rejected content", () => {
    const items = [
      makeItem({ score: 0.8, effective_at_epoch: nowSec - 60, approval_status: "rejected" }),
    ];
    expect(freshnessBoost(items, 0.1)[0].score).toBe(0.8);
  });

  it("falls back to crawl_timestamp when effective_at_epoch is missing", () => {
    const items = [makeItem({ score: 0.8, crawl_timestamp: nowSec - 60 })];
    expect(freshnessBoost(items, 0.1)[0].score).toBeGreaterThan(0.8);
  });

  it("preserves relative order when all have same freshness", () => {
    const ts = nowSec - 3600;
    const items = [
      makeItem({ score: 0.9, effective_at_epoch: ts }),
      makeItem({ score: 0.7, effective_at_epoch: ts }),
    ];
    const boosted = freshnessBoost(items, 0.1);
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });

  it("is generic — works with extended types", () => {
    interface Extended extends FreshnessBoostable {
      extra: string;
    }
    const items: Extended[] = [
      { score: 0.8, effective_at_epoch: nowSec - 60, extra: "kept" },
    ];
    const boosted = freshnessBoost(items, 0.1);
    expect(boosted[0].extra).toBe("kept");
    expect(boosted[0].score).toBeGreaterThan(0.8);
  });
});
