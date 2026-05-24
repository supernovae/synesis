import {
  computeCost,
  computeCostBreakdown,
  type PricingRates,
  type PricingSource,
} from "@synesis/telemetry";
import type { TierConfig } from "../providers/admin-tier-registry.js";
import { resolveEndpointCapabilityId } from "../providers/endpoint-capabilities/resolve.js";
import {
  buildTokenEconomicsDecision,
  tokenEconomicsLogRecord,
  type TokenEconomicsDecision,
} from "../telemetry/token-economics.js";
import { updateCachePolicyStateFromTokenEconomics } from "../telemetry/cache-policy-controller.js";
import type { ProviderCacheObservation } from "./session-store.js";

export interface PersistenceTokenEconomicsUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface PersistenceTokenEconomicsOptimizationLedger {
  prefixStableBytes?: number;
  inputCharsOriginal?: number;
  inputCharsFinal?: number;
}

export interface PersistenceTokenEconomicsFallbackPricingNotice {
  model: string;
  inputTokens: number;
  outputTokens: number;
  pricingSource: PricingSource;
  tierInputPerM: number | null;
  tierOutputPerM: number | null;
}

export interface RunPersistenceTokenEconomicsAccountingInput {
  resolvedModelId: string;
  traceModel: string;
  tier?: TierConfig;
  metadata: Record<string, unknown>;
  orgId: string;
  clientKind: string;
  usage: PersistenceTokenEconomicsUsage;
  optimizationLedger?: PersistenceTokenEconomicsOptimizationLedger;
  providerObservationTtlMs: number;
  recordProviderCacheObservation: (
    orgId: string,
    observation: ProviderCacheObservation,
    ttlMs: number,
  ) => Promise<void>;
  logFallbackPricing?: (notice: PersistenceTokenEconomicsFallbackPricingNotice) => void;
  warnProviderCacheObservation?: (err: unknown, provider: string) => void;
}

export interface PersistenceTokenEconomicsAccounting {
  tierRates: PricingRates;
  pricingSource: PricingSource;
  costBreakdown: ReturnType<typeof computeCostBreakdown>;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  endpointProvider: string;
  tokenEconomicsDecision: TokenEconomicsDecision;
  tokenEconomicsMetadata: Record<string, unknown>;
}

function tierPricingRates(tier: TierConfig | undefined): PricingRates {
  return {
    input_per_million: Number(tier?.inputPerM ?? 0),
    output_per_million: Number(tier?.outputPerM ?? 0),
    cached_input_per_million: tier?.cachedPerM ?? null,
    cache_write_input_per_million: tier?.cacheWritePerM ?? null,
  };
}

function usageForCost(usage: PersistenceTokenEconomicsUsage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    cached_prompt_tokens: usage.cachedTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
  };
}

export function runPersistenceTokenEconomicsAccounting(
  input: RunPersistenceTokenEconomicsAccountingInput,
): PersistenceTokenEconomicsAccounting {
  const tierRates = tierPricingRates(input.tier);
  let pricingSource: PricingSource = input.tier?.pricingSource ?? "unknown";
  const costUsage = usageForCost(input.usage);
  const result = computeCost(costUsage, tierRates);
  const costBreakdown = computeCostBreakdown(costUsage, tierRates);
  const estimatedCostUsd = result.estimated_cost_usd;
  if (pricingSource === "unknown" || pricingSource === "fallback_base") {
    pricingSource = result.pricing_source;
  }

  const actualCostUsd = input.usage.costUsd > 0 ? input.usage.costUsd : 0;
  if (actualCostUsd > 0) {
    pricingSource = "provider";
  }
  const normalizedEstimatedCostUsd = Number.isFinite(estimatedCostUsd) ? Math.max(0, estimatedCostUsd) : 0;
  const normalizedActualCostUsd = Number.isFinite(actualCostUsd) ? Math.max(0, actualCostUsd) : 0;
  const endpointProvider = input.tier?.baseUrl ? resolveEndpointCapabilityId(input.tier.baseUrl) : "generic";
  const tokenEconomicsDecision = buildTokenEconomicsDecision({
    provider: endpointProvider,
    tier: input.resolvedModelId,
    model: input.traceModel,
    promptTokens: input.usage.inputTokens,
    completionTokens: input.usage.outputTokens,
    cachedTokens: input.usage.cachedTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
    prefixStableBytes: input.optimizationLedger?.prefixStableBytes,
    inputCharsOriginal: input.optimizationLedger?.inputCharsOriginal,
    inputCharsFinal: input.optimizationLedger?.inputCharsFinal,
  });
  const cachePolicyState = updateCachePolicyStateFromTokenEconomics(
    input.metadata,
    tokenEconomicsDecision,
  );
  void input.recordProviderCacheObservation(
    input.orgId || "no-org",
    {
      provider: endpointProvider,
      clientKind: input.clientKind || "unknown-client",
      cacheOutcome: tokenEconomicsDecision.cacheOutcome,
      promptTokens: tokenEconomicsDecision.promptTokens,
      cachedTokens: tokenEconomicsDecision.cachedTokens,
      cacheCreationTokens: tokenEconomicsDecision.cacheCreationTokens,
    },
    input.providerObservationTtlMs,
  ).catch((err) => input.warnProviderCacheObservation?.(err, endpointProvider));

  const tokenEconomicsMetadata = {
    ...tokenEconomicsLogRecord(tokenEconomicsDecision),
    cache_policy_state: {
      cache_miss_streak: cachePolicyState.cacheMissStreak,
      cache_hit_streak: cachePolicyState.cacheHitStreak,
      premium_write_without_read_streak: cachePolicyState.premiumWriteWithoutReadStreak,
      telemetry_missing_streak: cachePolicyState.telemetryMissingStreak,
      last_cache_outcome: cachePolicyState.lastCacheOutcome,
      last_recommendation: cachePolicyState.lastRecommendation,
      last_provider_cache_strategy: cachePolicyState.lastProviderCacheStrategy,
    },
  };

  if (pricingSource === "fallback_base" && (input.usage.inputTokens + input.usage.outputTokens) > 0) {
    input.logFallbackPricing?.({
      model: input.traceModel,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      pricingSource,
      tierInputPerM: input.tier?.inputPerM ?? null,
      tierOutputPerM: input.tier?.outputPerM ?? null,
    });
  }

  return {
    tierRates,
    pricingSource,
    costBreakdown,
    normalizedEstimatedCostUsd,
    normalizedActualCostUsd,
    endpointProvider,
    tokenEconomicsDecision,
    tokenEconomicsMetadata,
  };
}
