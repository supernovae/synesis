import type { LlmUsage, PricingRates, CostResult } from "./types.js";

export const ZERO_USAGE: LlmUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_prompt_tokens: 0,
  estimated_cost_usd: 0,
  actual_cost_usd: 0,
};

export function computeCost(
  usage: LlmUsage,
  rates: PricingRates,
  cachedMultiplier = 0.1,
): CostResult {
  const uncached = Math.max(0, usage.prompt_tokens - usage.cached_prompt_tokens);
  const cachedRate =
    rates.cached_input_per_million ?? rates.input_per_million * cachedMultiplier;
  const estimated =
    (uncached / 1e6) * rates.input_per_million +
    (usage.cached_prompt_tokens / 1e6) * cachedRate +
    (usage.completion_tokens / 1e6) * rates.output_per_million;
  return { estimated_cost_usd: estimated };
}

export function resolveEffectiveCost(estimated: number, actual: number): number {
  return actual > 0 ? actual : estimated;
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
