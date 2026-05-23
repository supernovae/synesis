import type { LlmUsage, PricingRates, PricingSource, CostResult } from "./types.js";

export const ZERO_USAGE: LlmUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_prompt_tokens: 0,
  cache_creation_tokens: 0,
  estimated_cost_usd: 0,
  actual_cost_usd: 0,
};

/**
 * Platform-wide fallback base rates (USD per 1M tokens).
 * Applied when no provider, manual, infra, or API-lookup pricing is available.
 * Deliberately non-zero so cost reports never silently stay $0.00.
 * Operators should set real rates in the admin Model Registry;
 * these are a conservative floor for unpriced OSS/local models.
 */
export const FALLBACK_BASE_RATES: PricingRates = {
  input_per_million: 1.0,
  output_per_million: 5.0,
  cached_input_per_million: 0.1,
  cache_write_input_per_million: null,
};

export interface CostBreakdown {
  tokens_uncached_input: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_output: number;
  input_cost_usd: number;
  cache_read_cost_usd: number;
  cache_write_cost_usd: number;
  output_cost_usd: number;
  estimated_cost_usd: number;
  estimated_no_cache_cost_usd: number;
  cache_savings_usd: number;
}

export function hasNonZeroRates(rates: PricingRates): boolean {
  return rates.input_per_million > 0 || rates.output_per_million > 0;
}

function roundUsd(value: number): number {
  return Number(Math.max(-1_000_000_000, Math.min(1_000_000_000, value)).toFixed(8));
}

export function computeCostBreakdown(
  usage: LlmUsage,
  rates: PricingRates,
  cachedMultiplier = 0.1,
): CostBreakdown {
  const effectiveRates = hasNonZeroRates(rates) ? rates : FALLBACK_BASE_RATES;
  const prompt = Math.max(0, Math.floor(usage.prompt_tokens || 0));
  const cached = Math.min(prompt, Math.max(0, Math.floor(usage.cached_prompt_tokens || 0)));
  const uncached = Math.max(0, prompt - cached);
  const cacheWrite = Math.max(0, Math.floor(usage.cache_creation_tokens ?? 0));
  const output = Math.max(0, Math.floor(usage.completion_tokens || 0));
  const cachedRate =
    effectiveRates.cached_input_per_million ?? effectiveRates.input_per_million * cachedMultiplier;
  const cacheWriteRate =
    effectiveRates.cache_write_input_per_million ?? effectiveRates.input_per_million;

  const inputCost = (uncached / 1e6) * effectiveRates.input_per_million;
  const cacheReadCost = (cached / 1e6) * cachedRate;
  const cacheWriteCost = (cacheWrite / 1e6) * cacheWriteRate;
  const outputCost = (output / 1e6) * effectiveRates.output_per_million;
  const estimated = inputCost + cacheReadCost + cacheWriteCost + outputCost;
  const noCache = (prompt / 1e6) * effectiveRates.input_per_million
    + (output / 1e6) * effectiveRates.output_per_million;

  return {
    tokens_uncached_input: uncached,
    tokens_cache_read: cached,
    tokens_cache_write: cacheWrite,
    tokens_output: output,
    input_cost_usd: roundUsd(inputCost),
    cache_read_cost_usd: roundUsd(cacheReadCost),
    cache_write_cost_usd: roundUsd(cacheWriteCost),
    output_cost_usd: roundUsd(outputCost),
    estimated_cost_usd: roundUsd(estimated),
    estimated_no_cache_cost_usd: roundUsd(noCache),
    cache_savings_usd: roundUsd(noCache - estimated),
  };
}

export function computeCost(
  usage: LlmUsage,
  rates: PricingRates,
  cachedMultiplier = 0.1,
): CostResult {
  const effectiveRates = hasNonZeroRates(rates) ? rates : FALLBACK_BASE_RATES;
  const source: PricingSource = hasNonZeroRates(rates) ? "manual" : "fallback_base";
  const breakdown = computeCostBreakdown(usage, effectiveRates, cachedMultiplier);
  return { estimated_cost_usd: breakdown.estimated_cost_usd, pricing_source: source };
}

/**
 * Resolve cost with full pricing-source chain:
 *   1. provider-reported actual cost (highest trust)
 *   2. registry/computed estimated cost
 *   3. fallback base estimate
 */
export function resolveEffectiveCost(
  estimated: number,
  actual: number,
): { cost_usd: number; pricing_source: PricingSource } {
  if (actual > 0) return { cost_usd: actual, pricing_source: "provider" };
  if (estimated > 0) return { cost_usd: estimated, pricing_source: "manual" };
  return { cost_usd: 0, pricing_source: "unknown" };
}

export function mergeUsage(a: LlmUsage | undefined, b: LlmUsage): LlmUsage {
  if (!a) return { ...b };
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cached_prompt_tokens: a.cached_prompt_tokens + b.cached_prompt_tokens,
    cache_creation_tokens: (a.cache_creation_tokens ?? 0) + (b.cache_creation_tokens ?? 0),
    estimated_cost_usd: a.estimated_cost_usd + b.estimated_cost_usd,
    actual_cost_usd: a.actual_cost_usd + b.actual_cost_usd,
  };
}
