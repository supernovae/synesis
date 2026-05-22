export type LoopBreakMode = "standard" | "assertive" | "hands_off";
export type CachePolicyBias = "auto" | "cache_first" | "balanced" | "efficiency_first";

export interface UserRuntimePreferences {
  loopBreakMode: LoopBreakMode;
  cachePolicyBias: CachePolicyBias;
  allowAggressiveCompactionWithoutCacheHits: boolean;
  maxToolLoopSoftFails: number | null;
  updatedAt: number;
}

export interface LoopPolicyLimits {
  consecutiveToolCallsLimit: number;
  consecutiveToolCallsPivot: number;
  stagnantToolCyclesLimit: number;
  toolLoopNoUserAckHardLimit: number;
  hardRejectAfter: number;
}

export const DEFAULT_USER_RUNTIME_PREFERENCES: UserRuntimePreferences = {
  loopBreakMode: "standard",
  cachePolicyBias: "auto",
  allowAggressiveCompactionWithoutCacheHits: true,
  maxToolLoopSoftFails: null,
  updatedAt: 0,
};

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNullableLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

export function normalizeUserRuntimePreferences(value: unknown): UserRuntimePreferences {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    loopBreakMode: readEnum(
      raw.loopBreakMode ?? raw.loop_break_mode,
      ["standard", "assertive", "hands_off"] as const,
      DEFAULT_USER_RUNTIME_PREFERENCES.loopBreakMode,
    ),
    cachePolicyBias: readEnum(
      raw.cachePolicyBias ?? raw.cache_policy_bias,
      ["auto", "cache_first", "balanced", "efficiency_first"] as const,
      DEFAULT_USER_RUNTIME_PREFERENCES.cachePolicyBias,
    ),
    allowAggressiveCompactionWithoutCacheHits: readBool(
      raw.allowAggressiveCompactionWithoutCacheHits ?? raw.allow_aggressive_compaction_without_cache_hits,
      DEFAULT_USER_RUNTIME_PREFERENCES.allowAggressiveCompactionWithoutCacheHits,
    ),
    maxToolLoopSoftFails: readNullableLimit(raw.maxToolLoopSoftFails ?? raw.max_tool_loop_soft_fails),
    updatedAt: Number.isFinite(Number(raw.updatedAt ?? raw.updated_at)) ? Number(raw.updatedAt ?? raw.updated_at) : Date.now(),
  };
}

function atLeast(value: number, minimum: number): number {
  return Math.max(minimum, Math.floor(value));
}

function atMost(value: number, maximum: number): number {
  return Math.min(maximum, Math.floor(value));
}

export function applyRuntimePreferenceLoopLimits(
  base: LoopPolicyLimits,
  preferences: UserRuntimePreferences,
): LoopPolicyLimits {
  const limits = { ...base };
  if (preferences.loopBreakMode === "assertive") {
    limits.consecutiveToolCallsPivot = atMost(base.consecutiveToolCallsPivot, 8);
    limits.stagnantToolCyclesLimit = atMost(base.stagnantToolCyclesLimit, 5);
    limits.toolLoopNoUserAckHardLimit = atMost(base.toolLoopNoUserAckHardLimit, 3);
    limits.hardRejectAfter = atMost(base.hardRejectAfter, 4);
  } else if (preferences.loopBreakMode === "hands_off") {
    limits.consecutiveToolCallsPivot = atLeast(base.consecutiveToolCallsPivot, 20);
    limits.stagnantToolCyclesLimit = atLeast(base.stagnantToolCyclesLimit, 12);
    limits.toolLoopNoUserAckHardLimit = atLeast(base.toolLoopNoUserAckHardLimit, 6);
    limits.hardRejectAfter = atLeast(base.hardRejectAfter, 8);
  }

  if (preferences.maxToolLoopSoftFails !== null) {
    limits.toolLoopNoUserAckHardLimit = preferences.maxToolLoopSoftFails;
  }

  limits.consecutiveToolCallsLimit = Math.max(limits.consecutiveToolCallsLimit, limits.consecutiveToolCallsPivot + 1);
  return limits;
}

export function userRuntimePreferencesResponse(preferences: UserRuntimePreferences): Record<string, unknown> {
  return {
    preferences,
    options: {
      loopBreakMode: ["standard", "assertive", "hands_off"],
      cachePolicyBias: ["auto", "cache_first", "balanced", "efficiency_first"],
      maxToolLoopSoftFails: { min: 1, max: 20, nullable: true },
    },
  };
}
