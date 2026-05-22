import type { CompactionMode } from "../governance/context-budget-manager.js";
import {
  inferProviderCacheStrategy,
  type ProviderCacheStrategy,
  type TokenEconomicsDecision,
  type TokenEconomicsRecommendation,
  type CacheOutcome,
} from "./token-economics.js";

export type CachePolicyAction =
  | "observe"
  | "preserve_cache"
  | "safe_efficiency"
  | "safety_backoff";

export interface CachePolicyState {
  cacheMissStreak: number;
  cacheHitStreak: number;
  premiumWriteWithoutReadStreak: number;
  telemetryMissingStreak: number;
  lastCacheOutcome: CacheOutcome | "unknown";
  lastRecommendation: TokenEconomicsRecommendation | "unknown";
  lastProviderCacheStrategy: ProviderCacheStrategy;
}

export interface CachePolicyControllerInput {
  enabled: boolean;
  metadata: Record<string, unknown>;
  provider: string;
  configuredCompactionMode: CompactionMode;
  missStreakThreshold: number;
  telemetryMissingThreshold: number;
  premiumWriteWithoutReadThreshold: number;
  retryRiskStagnantCycles: number;
  stagnantToolCycles: number;
  awaitingToolLoopUserAck: boolean;
  toolLoopNoUserAckCount: number;
  consecutiveRecoveryFires: number;
  consecutiveEditContextMisses: number;
}

export interface CachePolicyControllerDecision {
  enabled: boolean;
  action: CachePolicyAction;
  compactionMode: CompactionMode;
  allowExplicitCacheMarkers: boolean;
  cacheUnavailable: boolean;
  retryLoopRisk: boolean;
  premiumCacheWriteSuppressed: boolean;
  provider: string;
  providerCacheStrategy: ProviderCacheStrategy;
  state: CachePolicyState;
  reasons: string[];
}

const DEFAULT_STATE: CachePolicyState = {
  cacheMissStreak: 0,
  cacheHitStreak: 0,
  premiumWriteWithoutReadStreak: 0,
  telemetryMissingStreak: 0,
  lastCacheOutcome: "unknown",
  lastRecommendation: "unknown",
  lastProviderCacheStrategy: "unknown",
};

function safeInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function readString<T extends string>(value: unknown, fallback: T): T {
  return typeof value === "string" && value.trim() ? value as T : fallback;
}

export function readCachePolicyState(metadata: Record<string, unknown>): CachePolicyState {
  return {
    cacheMissStreak: safeInt(metadata.cache_policy_cache_miss_streak),
    cacheHitStreak: safeInt(metadata.cache_policy_cache_hit_streak),
    premiumWriteWithoutReadStreak: safeInt(metadata.cache_policy_premium_write_without_read_streak),
    telemetryMissingStreak: safeInt(metadata.cache_policy_telemetry_missing_streak),
    lastCacheOutcome: readString(metadata.last_token_economics_cache_outcome, DEFAULT_STATE.lastCacheOutcome),
    lastRecommendation: readString(metadata.last_token_economics_recommendation, DEFAULT_STATE.lastRecommendation),
    lastProviderCacheStrategy: readString(
      metadata.last_provider_cache_strategy,
      DEFAULT_STATE.lastProviderCacheStrategy,
    ),
  };
}

export function updateCachePolicyStateFromTokenEconomics(
  metadata: Record<string, unknown>,
  decision: TokenEconomicsDecision,
): CachePolicyState {
  const prev = readCachePolicyState(metadata);
  const cacheHit = decision.cacheOutcome === "hit";
  const telemetryMissing = decision.cacheOutcome === "no_usage";
  const cacheMiss = decision.cacheOutcome === "miss" || decision.cacheOutcome === "write_without_read" || telemetryMissing;
  const premiumWriteWithoutRead =
    decision.strategy === "explicit_premium" && decision.cacheOutcome === "write_without_read";

  const next: CachePolicyState = {
    cacheMissStreak: cacheMiss ? prev.cacheMissStreak + 1 : 0,
    cacheHitStreak: cacheHit ? prev.cacheHitStreak + 1 : 0,
    premiumWriteWithoutReadStreak: premiumWriteWithoutRead
      ? prev.premiumWriteWithoutReadStreak + 1
      : (cacheHit ? 0 : prev.premiumWriteWithoutReadStreak),
    telemetryMissingStreak: telemetryMissing ? prev.telemetryMissingStreak + 1 : 0,
    lastCacheOutcome: decision.cacheOutcome,
    lastRecommendation: decision.recommendation,
    lastProviderCacheStrategy: decision.strategy,
  };

  metadata.cache_policy_cache_miss_streak = next.cacheMissStreak;
  metadata.cache_policy_cache_hit_streak = next.cacheHitStreak;
  metadata.cache_policy_premium_write_without_read_streak = next.premiumWriteWithoutReadStreak;
  metadata.cache_policy_telemetry_missing_streak = next.telemetryMissingStreak;
  metadata.last_token_economics_cache_outcome = next.lastCacheOutcome;
  metadata.last_token_economics_recommendation = next.lastRecommendation;
  metadata.last_provider_cache_strategy = next.lastProviderCacheStrategy;

  return next;
}

export function evaluateCachePolicyController(input: CachePolicyControllerInput): CachePolicyControllerDecision {
  const state = readCachePolicyState(input.metadata);
  const providerCacheStrategy = inferProviderCacheStrategy(input.provider || state.lastProviderCacheStrategy);
  const missThreshold = Math.max(1, input.missStreakThreshold);
  const telemetryThreshold = Math.max(1, input.telemetryMissingThreshold);
  const premiumThreshold = Math.max(1, input.premiumWriteWithoutReadThreshold);
  const retryRiskThreshold = Math.max(1, input.retryRiskStagnantCycles);
  const cacheUnavailable =
    state.cacheMissStreak >= missThreshold
    || state.telemetryMissingStreak >= telemetryThreshold;
  const retryLoopRisk =
    input.stagnantToolCycles >= retryRiskThreshold
    || input.awaitingToolLoopUserAck
    || input.toolLoopNoUserAckCount > 0
    || input.consecutiveRecoveryFires > 0
    || input.consecutiveEditContextMisses >= 2;
  const premiumCacheWriteSuppressed =
    providerCacheStrategy === "explicit_premium"
    && state.premiumWriteWithoutReadStreak >= premiumThreshold;

  const reasons: string[] = [];
  if (!input.enabled) {
    return {
      enabled: false,
      action: "observe",
      compactionMode: input.configuredCompactionMode,
      allowExplicitCacheMarkers: true,
      cacheUnavailable,
      retryLoopRisk,
      premiumCacheWriteSuppressed: false,
      provider: input.provider,
      providerCacheStrategy,
      state,
      reasons: ["controller_disabled"],
    };
  }

  if (cacheUnavailable) reasons.push("cache_unavailable_or_unreported");
  if (retryLoopRisk) reasons.push("retry_loop_or_comprehension_risk");
  if (premiumCacheWriteSuppressed) reasons.push("premium_cache_write_without_read_streak");

  let action: CachePolicyAction = "observe";
  let compactionMode = input.configuredCompactionMode;

  if (retryLoopRisk) {
    action = "safety_backoff";
    compactionMode = "minimal";
  } else if (cacheUnavailable) {
    action = "safe_efficiency";
    compactionMode = "aggressive";
  } else if (state.cacheHitStreak > 0) {
    action = "preserve_cache";
    compactionMode = "minimal";
    reasons.push("provider_cache_hit_observed");
  }

  return {
    enabled: true,
    action,
    compactionMode,
    allowExplicitCacheMarkers: !premiumCacheWriteSuppressed,
    cacheUnavailable,
    retryLoopRisk,
    premiumCacheWriteSuppressed,
    provider: input.provider,
    providerCacheStrategy,
    state,
    reasons,
  };
}

export function cachePolicyLogRecord(decision: CachePolicyControllerDecision): Record<string, unknown> {
  return {
    enabled: decision.enabled,
    action: decision.action,
    compaction_mode: decision.compactionMode,
    allow_explicit_cache_markers: decision.allowExplicitCacheMarkers,
    cache_unavailable: decision.cacheUnavailable,
    retry_loop_risk: decision.retryLoopRisk,
    premium_cache_write_suppressed: decision.premiumCacheWriteSuppressed,
    provider: decision.provider,
    provider_cache_strategy: decision.providerCacheStrategy,
    reasons: decision.reasons,
    state: {
      cache_miss_streak: decision.state.cacheMissStreak,
      cache_hit_streak: decision.state.cacheHitStreak,
      premium_write_without_read_streak: decision.state.premiumWriteWithoutReadStreak,
      telemetry_missing_streak: decision.state.telemetryMissingStreak,
      last_cache_outcome: decision.state.lastCacheOutcome,
      last_recommendation: decision.state.lastRecommendation,
      last_provider_cache_strategy: decision.state.lastProviderCacheStrategy,
    },
  };
}
