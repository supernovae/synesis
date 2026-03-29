import type { LlmUsage, PricingRates, PricingSource, CostResult } from "./types.js";

export const ZERO_USAGE: LlmUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_prompt_tokens: 0,
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
};

export function hasNonZeroRates(rates: PricingRates): boolean {
  return rates.input_per_million > 0 || rates.output_per_million > 0;
}

export function computeCost(
  usage: LlmUsage,
  rates: PricingRates,
  cachedMultiplier = 0.1,
): CostResult {
  const effectiveRates = hasNonZeroRates(rates) ? rates : FALLBACK_BASE_RATES;
  const source: PricingSource = hasNonZeroRates(rates) ? "manual" : "fallback_base";

  const uncached = Math.max(0, usage.prompt_tokens - usage.cached_prompt_tokens);
  const cachedRate =
    effectiveRates.cached_input_per_million ?? effectiveRates.input_per_million * cachedMultiplier;
  const estimated =
    (uncached / 1e6) * effectiveRates.input_per_million +
    (usage.cached_prompt_tokens / 1e6) * cachedRate +
    (usage.completion_tokens / 1e6) * effectiveRates.output_per_million;
  return { estimated_cost_usd: estimated, pricing_source: source };
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
    estimated_cost_usd: a.estimated_cost_usd + b.estimated_cost_usd,
    actual_cost_usd: a.actual_cost_usd + b.actual_cost_usd,
  };
}
