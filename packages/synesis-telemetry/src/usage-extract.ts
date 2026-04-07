import type { LlmUsage } from "./types.js";
import { ZERO_USAGE } from "./cost.js";

interface ProviderUsage {
  prompt_tokens?: number;
  promptTokens?: number;
  completion_tokens?: number;
  completionTokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cached_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cachedTokens?: number; cacheWriteTokens?: number };
  costUsd?: number;
  cost_usd?: number;
  estimated_cost?: number;
}

/**
 * Normalize diverse provider usage formats into LlmUsage.
 * Handles OpenAI, Anthropic, vLLM, AI SDK, and custom provider shapes.
 */
export function extractUsage(raw?: ProviderUsage | null): LlmUsage {
  if (!raw) return { ...ZERO_USAGE };

  const prompt = Number(
    raw.prompt_tokens ?? raw.promptTokens ?? raw.inputTokens ?? raw.input_tokens ?? 0,
  );
  const completion = Number(
    raw.completion_tokens ?? raw.completionTokens ?? raw.outputTokens ?? raw.output_tokens ?? 0,
  );
  const total = Number(raw.total_tokens ?? 0) || prompt + completion;
  const cached = Number(
    raw.prompt_tokens_details?.cached_tokens ??
      raw.cached_tokens ??
      raw.cachedInputTokens ??
      raw.cached_input_tokens ??
      raw.cache_read_input_tokens ??
      raw.inputTokenDetails?.cacheReadTokens ??
      raw.inputTokenDetails?.cachedTokens ??
      raw.prompt_cache_hit_tokens ??
      0,
  );
  const cacheCreation = Number(
    raw.cache_creation_input_tokens ??
      raw.inputTokenDetails?.cacheWriteTokens ??
      0,
  );
  const actualCost = Number(raw.costUsd ?? raw.cost_usd ?? raw.estimated_cost ?? 0);

  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
    cached_prompt_tokens: Number.isFinite(cached) ? cached : 0,
    cache_creation_tokens: Number.isFinite(cacheCreation) ? cacheCreation : 0,
    estimated_cost_usd: 0,
    actual_cost_usd: Number.isFinite(actualCost) ? actualCost : 0,
  };
}
