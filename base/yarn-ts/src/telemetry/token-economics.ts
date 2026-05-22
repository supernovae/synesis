const CHARS_PER_TOKEN = 4;

export type ProviderCacheStrategy =
  | "explicit_premium"
  | "explicit_ephemeral"
  | "implicit_prefix"
  | "reported_only"
  | "none"
  | "unknown";

export type CacheOutcome =
  | "hit"
  | "write_without_read"
  | "miss"
  | "no_usage";

export type TokenEconomicsRecommendation =
  | "cache_healthy"
  | "disable_premium_cache_write"
  | "preserve_stable_prefix_and_investigate"
  | "observe_more"
  | "telemetry_missing";

export interface TokenEconomicsInput {
  provider: string;
  tier: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  messageCount?: number;
  cacheMarkerCount?: number;
  prefixStableBytes?: number;
  inputCharsOriginal?: number;
  inputCharsFinal?: number;
}

export interface TokenEconomicsDecision {
  provider: string;
  tier: string;
  model: string;
  strategy: ProviderCacheStrategy;
  cacheOutcome: CacheOutcome;
  recommendation: TokenEconomicsRecommendation;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  cacheHitPct: number;
  estimatedTokensSavedByCompaction: number;
  messageCount: number;
  cacheMarkerCount: number;
  prefixStableBytes: number;
  warnings: string[];
}

function safeNonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

export function inferProviderCacheStrategy(provider: string): ProviderCacheStrategy {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "dashscope" || normalized.includes("dashscope")) return "explicit_premium";
  if (normalized === "anthropic" || normalized.includes("claude")) return "explicit_ephemeral";
  if (
    normalized === "openai"
    || normalized === "deepseek"
    || normalized === "openrouter"
    || normalized === "vllm"
    || normalized === "fireworks"
    || normalized.includes("deepinfra")
  ) {
    return "implicit_prefix";
  }
  if (normalized === "generic") return "unknown";
  return "reported_only";
}

export function buildTokenEconomicsDecision(input: TokenEconomicsInput): TokenEconomicsDecision {
  const promptTokens = safeNonNegativeInt(input.promptTokens);
  const completionTokens = safeNonNegativeInt(input.completionTokens);
  const cachedTokens = Math.min(safeNonNegativeInt(input.cachedTokens), promptTokens);
  const cacheCreationTokens = safeNonNegativeInt(input.cacheCreationTokens);
  const messageCount = safeNonNegativeInt(input.messageCount);
  const cacheMarkerCount = safeNonNegativeInt(input.cacheMarkerCount);
  const prefixStableBytes = safeNonNegativeInt(input.prefixStableBytes);
  const originalChars = safeNonNegativeInt(input.inputCharsOriginal);
  const finalChars = safeNonNegativeInt(input.inputCharsFinal);
  const estimatedTokensSavedByCompaction =
    originalChars > 0 && finalChars > 0
      ? Math.max(0, Math.ceil((originalChars - finalChars) / CHARS_PER_TOKEN))
      : 0;

  const strategy = inferProviderCacheStrategy(input.provider);
  const cacheHitPct = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
  const cacheOutcome: CacheOutcome =
    promptTokens <= 0 && completionTokens <= 0
      ? "no_usage"
      : cachedTokens > 0
        ? "hit"
        : cacheCreationTokens > 0
          ? "write_without_read"
          : "miss";

  const warnings: string[] = [];
  let recommendation: TokenEconomicsRecommendation;

  if (cacheOutcome === "no_usage") {
    warnings.push("provider_usage_missing");
    recommendation = "telemetry_missing";
  } else if (cacheOutcome === "hit") {
    recommendation = "cache_healthy";
  } else if (strategy === "explicit_premium" && cacheOutcome === "write_without_read") {
    warnings.push("premium_cache_write_without_read");
    recommendation = "disable_premium_cache_write";
  } else if (cacheOutcome === "miss" || cacheOutcome === "write_without_read") {
    warnings.push("cacheable_prompt_without_provider_hit");
    recommendation = promptTokens >= 1024
      ? "preserve_stable_prefix_and_investigate"
      : "observe_more";
  } else {
    recommendation = "observe_more";
  }

  if (estimatedTokensSavedByCompaction > 0 && cachedTokens === 0 && promptTokens >= 1024) {
    warnings.push("compaction_savings_unproven_without_cache_hit");
  }

  return {
    provider: input.provider,
    tier: input.tier,
    model: input.model,
    strategy,
    cacheOutcome,
    recommendation,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheCreationTokens,
    cacheHitPct,
    estimatedTokensSavedByCompaction,
    messageCount,
    cacheMarkerCount,
    prefixStableBytes,
    warnings,
  };
}

export function tokenEconomicsLogRecord(decision: TokenEconomicsDecision): Record<string, unknown> {
  return {
    strategy: decision.strategy,
    cache_outcome: decision.cacheOutcome,
    recommendation: decision.recommendation,
    cache_hit_pct: decision.cacheHitPct,
    cached_tokens: decision.cachedTokens,
    cache_creation_tokens: decision.cacheCreationTokens,
    prompt_tokens: decision.promptTokens,
    completion_tokens: decision.completionTokens,
    message_count: decision.messageCount,
    cache_marker_count: decision.cacheMarkerCount,
    prefix_stable_bytes: decision.prefixStableBytes,
    estimated_tokens_saved_by_compaction: decision.estimatedTokensSavedByCompaction,
    warnings: decision.warnings,
  };
}
