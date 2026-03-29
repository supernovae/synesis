import { describe, expect, it } from "vitest";
import {
  computeCost,
  resolveEffectiveCost,
  FALLBACK_BASE_RATES,
  hasNonZeroRates,
  ZERO_USAGE,
} from "@synesis/telemetry";

describe("computeCost", () => {
  it("uses provided rates when non-zero", () => {
    const result = computeCost(
      { ...ZERO_USAGE, prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { input_per_million: 2.0, output_per_million: 8.0, cached_input_per_million: null },
    );
    expect(result.estimated_cost_usd).toBeCloseTo(0.006, 6);
    expect(result.pricing_source).toBe("manual");
  });

  it("falls back to base rates when provided rates are zero", () => {
    const result = computeCost(
      { ...ZERO_USAGE, prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 },
      { input_per_million: 0, output_per_million: 0, cached_input_per_million: null },
    );
    expect(result.estimated_cost_usd).toBeGreaterThan(0);
    expect(result.pricing_source).toBe("fallback_base");
    expect(result.estimated_cost_usd).toBeCloseTo(
      FALLBACK_BASE_RATES.input_per_million * 1.0 +
      FALLBACK_BASE_RATES.output_per_million * 0.5,
      4,
    );
  });

  it("accounts for cached tokens with explicit cached rate", () => {
    const result = computeCost(
      { ...ZERO_USAGE, prompt_tokens: 1000, cached_prompt_tokens: 600, completion_tokens: 200, total_tokens: 1200 },
      { input_per_million: 3.0, output_per_million: 15.0, cached_input_per_million: 0.3 },
    );
    const uncached = 400;
    const expected =
      (uncached / 1e6) * 3.0 +
      (600 / 1e6) * 0.3 +
      (200 / 1e6) * 15.0;
    expect(result.estimated_cost_usd).toBeCloseTo(expected, 8);
    expect(result.pricing_source).toBe("manual");
  });

  it("returns zero cost and fallback source for zero tokens with zero rates", () => {
    const result = computeCost(
      ZERO_USAGE,
      { input_per_million: 0, output_per_million: 0, cached_input_per_million: null },
    );
    expect(result.estimated_cost_usd).toBe(0);
    expect(result.pricing_source).toBe("fallback_base");
  });
});

describe("resolveEffectiveCost", () => {
  it("prefers provider-reported actual cost", () => {
    const result = resolveEffectiveCost(0.01, 0.02);
    expect(result.cost_usd).toBe(0.02);
    expect(result.pricing_source).toBe("provider");
  });

  it("falls back to estimated cost when actual is 0", () => {
    const result = resolveEffectiveCost(0.01, 0);
    expect(result.cost_usd).toBe(0.01);
    expect(result.pricing_source).toBe("manual");
  });

  it("returns unknown when both are 0", () => {
    const result = resolveEffectiveCost(0, 0);
    expect(result.cost_usd).toBe(0);
    expect(result.pricing_source).toBe("unknown");
  });
});

describe("hasNonZeroRates", () => {
  it("returns true when input rate is positive", () => {
    expect(hasNonZeroRates({ input_per_million: 1, output_per_million: 0, cached_input_per_million: null })).toBe(true);
  });

  it("returns true when output rate is positive", () => {
    expect(hasNonZeroRates({ input_per_million: 0, output_per_million: 5, cached_input_per_million: null })).toBe(true);
  });

  it("returns false when both rates are zero", () => {
    expect(hasNonZeroRates({ input_per_million: 0, output_per_million: 0, cached_input_per_million: null })).toBe(false);
  });
});

describe("FALLBACK_BASE_RATES", () => {
  it("has non-zero rates", () => {
    expect(FALLBACK_BASE_RATES.input_per_million).toBeGreaterThan(0);
    expect(FALLBACK_BASE_RATES.output_per_million).toBeGreaterThan(0);
  });

  it("has a cached rate lower than input rate", () => {
    expect(FALLBACK_BASE_RATES.cached_input_per_million).toBeLessThan(
      FALLBACK_BASE_RATES.input_per_million,
    );
  });
});
