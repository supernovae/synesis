import { extractUsage } from "@synesis/telemetry";

export interface NormalizedProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface NormalizeProviderUsageOptions {
  debug?: boolean;
  logger?: {
    debug(obj: Record<string, unknown>, message: string): void;
  };
}

export function normalizeProviderUsage(
  input: unknown,
  options: NormalizeProviderUsageOptions = {},
): NormalizedProviderUsage {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (options.debug) {
    options.logger?.debug({ rawUsage: obj }, "raw_usage_from_sdk");
  }

  const normalized = extractUsage(obj as never);
  const cost = Number(obj.costUsd ?? obj.cost_usd ?? obj.estimated_cost ?? normalized.actual_cost_usd ?? 0);
  const cacheCreationTokens = Number(normalized.cache_creation_tokens ?? 0);
  return {
    inputTokens: Number.isFinite(normalized.prompt_tokens) ? normalized.prompt_tokens : 0,
    outputTokens: Number.isFinite(normalized.completion_tokens) ? normalized.completion_tokens : 0,
    cachedTokens: Number.isFinite(normalized.cached_prompt_tokens) ? normalized.cached_prompt_tokens : 0,
    cacheCreationTokens: Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0,
    costUsd: Number.isFinite(cost) ? cost : 0,
  };
}
