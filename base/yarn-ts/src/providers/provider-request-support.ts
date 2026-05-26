import { createHash } from "node:crypto";

import type { MarkerBackend } from "./prefix-optimizer/index.js";
import type { SynesisProviderRegistry, DashScopeCacheOpts } from "./synesis-provider.js";
import type { AppConfig } from "../config.js";
import type { CompactionMode } from "../governance/context-budget-manager.js";
import type { GovernedToolCall } from "../path-governance/tool-call-governance.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import { resolveEndpointCapabilityId } from "../providers/endpoint-capabilities/resolve.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import {
  DEFAULT_USER_RUNTIME_PREFERENCES,
  normalizeUserRuntimePreferences,
  type UserRuntimePreferences,
} from "../runtime/user-preferences.js";
import type { SessionState } from "../state/session-state.js";
import type { SessionStore } from "../state/session-store.js";
import {
  evaluateCachePolicyController,
  type CachePolicyControllerDecision,
  type ProviderCachePolicyWindow,
} from "../telemetry/cache-policy-controller.js";
import {
  openAIMessagesToModelMessages,
  ensureSystemMessagesAtBeginning,
  coalesceLeadingSystemMessages,
  sanitizeToolCalls,
} from "../tool-mapping.js";

type LoggerLike = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type ResolveResult =
  | {
      ok: true;
      resolved: { model: unknown; resolvedModelId: string; adapter: ModelAdapter };
      messages: ReturnType<typeof openAIMessagesToModelMessages>;
      transforms: {
        systemMessagesReordered: boolean;
        toolCallsSanitized: boolean;
        messageCountDelta: number;
      };
    }
  | { ok: false; error: string };

export interface ProviderRequestSupportInput {
  config: AppConfig;
  logger: LoggerLike;
  tierRegistry: SynesisProviderRegistry;
  sessionStore: SessionStore;
}

export interface ProviderRequestSupport {
  loadUserRuntimePreferences(userId: string): Promise<UserRuntimePreferences>;
  loadProviderCachePolicyWindow(
    orgId: string,
    provider: string,
    clientKind: string,
  ): Promise<ProviderCachePolicyWindow | null>;
  evaluateCachePolicyForSession(
    session: SessionState,
    provider: string,
    configuredCompactionMode: CompactionMode,
    providerWindow?: ProviderCachePolicyWindow | null,
    runtimePreferences?: UserRuntimePreferences | null,
  ): CachePolicyControllerDecision;
  markerBackendForRequest(
    modelId: string,
    fallbackModelId: string,
    sessionKey: string,
    cachePolicy?: CachePolicyControllerDecision,
  ): MarkerBackend;
  runOpenAIRequest(request: OpenAIChatCompletionRequest): ResolveResult;
  shouldSampleBySeed(seed: string, rate: number): boolean;
  maybeLogEnvelopeUnwrapSample(
    logger: { info: (obj: Record<string, unknown>, msg?: string) => void },
    reqId: string,
    toolName: string,
    clientKind: string,
    governed: GovernedToolCall,
    toolCallId?: string,
  ): void;
}

const dashScopeCacheOpts: DashScopeCacheOpts = {
  enabled: false,
  maxMarkers: 0,
};

export function createProviderRequestSupport(input: ProviderRequestSupportInput): ProviderRequestSupport {
  const { config, logger, tierRegistry, sessionStore } = input;

  function dashscopeCanaryEnabledForSession(sessionKey: string): boolean {
    const pct = Math.max(0, Math.min(100, Math.floor(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT)));
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    const hash = createHash("sha256").update(sessionKey || "anon").digest();
    return hash.readUInt32BE(0) % 100 < pct;
  }

  async function loadUserRuntimePreferences(userId: string): Promise<UserRuntimePreferences> {
    if (!config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_ENABLED || !userId || userId === "anon") {
      return DEFAULT_USER_RUNTIME_PREFERENCES;
    }
    try {
      const raw = await sessionStore.loadUserRuntimePreferences(userId);
      return normalizeUserRuntimePreferences(raw);
    } catch (err) {
      logger.warn({ err, userId }, "user_runtime_preferences_load_failed");
      return DEFAULT_USER_RUNTIME_PREFERENCES;
    }
  }

  async function loadProviderCachePolicyWindow(
    orgId: string,
    provider: string,
    clientKind: string,
  ): Promise<ProviderCachePolicyWindow | null> {
    if (!config.SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED) return null;
    try {
      return await sessionStore.loadProviderCacheWindow(
        orgId || "no-org",
        provider || "unknown",
        config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_HOURS,
        clientKind || "unknown-client",
      );
    } catch (err) {
      logger.warn({ err, orgId, provider, clientKind }, "provider_cache_policy_window_load_failed");
      return null;
    }
  }

  function evaluateCachePolicyForSession(
    session: SessionState,
    provider: string,
    configuredCompactionMode: CompactionMode,
    providerWindow?: ProviderCachePolicyWindow | null,
    runtimePreferences?: UserRuntimePreferences | null,
  ): CachePolicyControllerDecision {
    return evaluateCachePolicyController({
      enabled: config.SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED,
      metadata: session.record.metadata,
      provider,
      configuredCompactionMode,
      missStreakThreshold: config.SYNESIS_YARN_CACHE_POLICY_MISS_STREAK_THRESHOLD,
      telemetryMissingThreshold: config.SYNESIS_YARN_CACHE_POLICY_TELEMETRY_MISSING_THRESHOLD,
      premiumWriteWithoutReadThreshold: config.SYNESIS_YARN_CACHE_POLICY_PREMIUM_WRITE_STREAK_THRESHOLD,
      retryRiskStagnantCycles: config.SYNESIS_YARN_CACHE_POLICY_RETRY_RISK_STAGNANT_CYCLES,
      stagnantToolCycles: session.stagnantToolCycles,
      awaitingToolLoopUserAck: session.awaitingToolLoopUserAck,
      toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
      consecutiveRecoveryFires: session.consecutiveRecoveryFires,
      consecutiveEditContextMisses: session.consecutiveEditContextMisses,
      providerWindow,
      providerWindowMinRequests: config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_MIN_REQUESTS,
      runtimePreferences,
    });
  }

  function markerBackendForRequest(
    modelId: string,
    fallbackModelId: string,
    sessionKey: string,
    cachePolicy?: CachePolicyControllerDecision,
  ): MarkerBackend {
    if (cachePolicy && !cachePolicy.allowExplicitCacheMarkers) return "none";
    const mode = config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE;
    if (mode === "off") return "none";
    if (mode === "canary" && !dashscopeCanaryEnabledForSession(sessionKey)) return "none";
    const primary = tierRegistry.getTierConfig(modelId);
    const fallback = tierRegistry.getTierConfig(fallbackModelId);
    const tier = primary ?? fallback;
    if (!tier || resolveEndpointCapabilityId(tier.baseUrl) !== "dashscope") return "none";
    return "dashscope";
  }

  function runOpenAIRequest(request: OpenAIChatCompletionRequest): ResolveResult {
    try {
      const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER, dashScopeCacheOpts);
      const systemOrdered = ensureSystemMessagesAtBeginning(request.messages as never);
      const systemCoalesced = coalesceLeadingSystemMessages(systemOrdered as never);
      const sanitized = sanitizeToolCalls(systemCoalesced as never);
      let toolCallsSanitized = false;
      try {
        toolCallsSanitized = JSON.stringify(systemCoalesced) !== JSON.stringify(sanitized);
      } catch {
        toolCallsSanitized = systemCoalesced.length !== sanitized.length;
      }
      const messages = openAIMessagesToModelMessages(sanitized);
      return {
        ok: true,
        resolved,
        messages,
        transforms: {
          systemMessagesReordered: systemOrdered !== (request.messages as never),
          toolCallsSanitized,
          messageCountDelta: sanitized.length - ((request.messages as unknown[])?.length ?? 0),
        },
      };
    } catch {
      return { ok: false, error: "No model configuration available — the service may still be initializing" };
    }
  }

  function shouldSampleBySeed(seed: string, rate: number): boolean {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const normalized = (hash >>> 0) / 0xffffffff;
    return normalized < rate;
  }

  function maybeLogEnvelopeUnwrapSample(
    log: { info: (obj: Record<string, unknown>, msg?: string) => void },
    reqId: string,
    toolName: string,
    clientKind: string,
    governed: GovernedToolCall,
    toolCallId?: string,
  ): void {
    if (!governed.envelopeUnwrapped) return;
    const source = governed.envelopeSource ?? "unknown";
    const seed = `${reqId}:${toolCallId ?? "_"}:${toolName}:${source}:${clientKind}`;
    if (!shouldSampleBySeed(seed, config.SYNESIS_YARN_ENVELOPE_UNWRAP_LOG_SAMPLE_RATE)) return;
    log.info(
      {
        reqId,
        toolName,
        toolCallId: toolCallId ?? null,
        clientKind,
        envelopeSource: source,
        sampled: true,
      },
      "tool_args_envelope_unwrapped",
    );
  }

  return {
    loadUserRuntimePreferences,
    loadProviderCachePolicyWindow,
    evaluateCachePolicyForSession,
    markerBackendForRequest,
    runOpenAIRequest,
    shouldSampleBySeed,
    maybeLogEnvelopeUnwrapSample,
  };
}
