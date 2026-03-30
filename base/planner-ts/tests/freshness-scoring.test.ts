import { describe, it, expect } from "vitest";
import { freshnessScore, freshnessBoost } from "../src/retrieval/unified.js";
import type { UnifiedResult } from "../src/retrieval/types.js";

function makeResult(overrides: Partial<UnifiedResult> = {}): UnifiedResult {
  return {
    id: "test-1",
    text: "chunk text",
    score: 1.0,
    source: "rag" as const,
    uri: "https://example.com",
    title: "Test",
    authority: "community",
    ...overrides,
  };
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

  it("returns ~0.5 at the half-life boundary", () => {
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
    const score = freshnessScore(ninetyDaysAgo, 90);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it("decays toward zero for very old timestamps", () => {
    const threeYearsAgo = Date.now() - 365 * 3 * 86_400_000;
    const score = freshnessScore(threeYearsAgo, 90);
    expect(score).toBeLessThan(0.001);
  });

  it("respects custom half-life", () => {
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    const fast = freshnessScore(thirtyDaysAgo, 30);
    const slow = freshnessScore(thirtyDaysAgo, 180);
    expect(fast).toBeCloseTo(0.5, 1);
    expect(slow).toBeGreaterThan(0.85);
  });
});

describe("freshnessBoost", () => {
  const nowEpochSec = Math.floor(Date.now() / 1000);

  it("returns results unchanged when weight is 0", () => {
    const results = [makeResult({ score: 0.8 })];
    const boosted = freshnessBoost(results, 0);
    expect(boosted[0].score).toBe(0.8);
  });

  it("boosts recent results", () => {
    const results = [
      makeResult({ score: 0.8, effective_at_epoch: nowEpochSec - 60 }),
    ];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBeGreaterThan(0.8);
  });

  it("does not boost results without timestamps", () => {
    const results = [makeResult({ score: 0.8 })];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBe(0.8);
  });

  it("does not boost flagged content", () => {
    const results = [
      makeResult({
        score: 0.8,
        effective_at_epoch: nowEpochSec - 60,
        scan_status: "flagged",
      }),
    ];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBe(0.8);
  });

  it("does not boost rejected content", () => {
    const results = [
      makeResult({
        score: 0.8,
        effective_at_epoch: nowEpochSec - 60,
        approval_status: "rejected",
      }),
    ];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBe(0.8);
  });

  it("falls back to crawl_timestamp when effective_at_epoch is missing", () => {
    const results = [
      makeResult({ score: 0.8, crawl_timestamp: nowEpochSec - 60 }),
    ];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBeGreaterThan(0.8);
  });

  it("preserves relative order when all have same freshness", () => {
    const ts = nowEpochSec - 3600;
    const results = [
      makeResult({ id: "a", score: 0.9, effective_at_epoch: ts }),
      makeResult({ id: "b", score: 0.7, effective_at_epoch: ts }),
    ];
    const boosted = freshnessBoost(results, 0.1);
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });
});
