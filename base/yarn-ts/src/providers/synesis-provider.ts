import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { normalizeOpenAICompatTierModelId, type TierConfig } from "./admin-tier-registry.js";
import { type ModelAdapter, resolveAdapter } from "./model-adapter.js";
import { createUsageTelemetryFetch } from "./usage-telemetry-fetch.js";
import type { CacheDebugTraceMode } from "../telemetry/cache-debug-trace.js";
import type { PrefixOptimizer } from "./prefix-optimizer/index.js";
import {
  composeEndpointTransportFetch,
  type EndpointTransportRetryPolicy,
} from "./endpoint-capabilities/compose-fetch.js";
import type { DashScopeEndpointAdapterOptions } from "./endpoint-capabilities/dashscope.js";
import { getEndpointTransportAdapter } from "./endpoint-capabilities/registry.js";
import { resolveEndpointCapabilityId } from "./endpoint-capabilities/resolve.js";

export interface DashScopeCacheOpts {
  enabled: boolean;
  maxMarkers: number;
}

export class SynesisProviderRegistry {
  private tierMap = new Map<string, TierConfig>();
  private prefixOptimizer: PrefixOptimizer | null = null;
  private currentSessionKey: string | null = null;
  private currentRequestId: string | null = null;
  private currentClientKind: string | null = null;
  private readonly upstreamRetryPolicy: EndpointTransportRetryPolicy;
  private readonly dashscopeOptions: DashScopeEndpointAdapterOptions;
  private readonly cacheDebugTraceMode: CacheDebugTraceMode;

  constructor(opts?: {
    upstreamRetryPolicy?: EndpointTransportRetryPolicy;
    dashscopeOptions?: DashScopeEndpointAdapterOptions;
    cacheDebugTraceMode?: CacheDebugTraceMode;
  }) {
    this.upstreamRetryPolicy = opts?.upstreamRetryPolicy ?? {
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
      jitterMs: 125,
    };
    this.dashscopeOptions = opts?.dashscopeOptions ?? { mode: "off", canaryPct: 0, maxMarkers: 3 };
    this.cacheDebugTraceMode = opts?.cacheDebugTraceMode ?? "off";
  }

  updateTiers(tiers: TierConfig[]): void {
    this.tierMap.clear();
    for (const tier of tiers) {
      this.tierMap.set(tier.id, tier);
    }
  }

  /**
   * Set the prefix optimizer instance.
   * Called once at startup from index.ts.
   */
  setPrefixOptimizer(optimizer: PrefixOptimizer): void {
    this.prefixOptimizer = optimizer;
  }

  /**
   * Set the current session key for marker index lookup.
   * Must be called before resolve() so the fetch interceptor
   * can look up the correct marker indices.
   */
  setCurrentSessionKey(sessionKey: string): void {
    this.currentSessionKey = sessionKey;
  }

  setCurrentRequestContext(context: { sessionKey: string; requestId?: string | null; clientKind?: string | null }): void {
    this.currentSessionKey = context.sessionKey;
    this.currentRequestId = context.requestId ?? null;
    this.currentClientKind = context.clientKind ?? null;
  }

  private cacheDebugTraceContext() {
    return {
      sessionKey: this.currentSessionKey,
      requestId: this.currentRequestId,
      clientKind: this.currentClientKind,
    };
  }

  getAvailableModels(): Array<{ id: string; object: "model"; owned_by: string; created: number }> {
    const fromMap = Array.from(this.tierMap.keys());
    const shortIds: string[] = [];
    for (const s of ["pulse", "core", "horizon", "compaction"]) {
      const canon = normalizeOpenAICompatTierModelId(s);
      if (this.tierMap.has(canon)) shortIds.push(s);
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    const push = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    push("auto");
    for (const id of shortIds.sort((a, b) => a.localeCompare(b))) push(id);
    for (const id of fromMap.sort((a, b) => a.localeCompare(b))) push(id);
    return ids.map((id) => ({
      id,
      object: "model" as const,
      owned_by: "synesis",
      created: 1704067200,
    }));
  }

  resolve(
    modelId: string,
    fallbackModelId: string,
    /** @deprecated ignored — DashScope explicit cache removed; kept for call-site compatibility. */
    _dashScopeCache?: DashScopeCacheOpts,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const primary = normalizeOpenAICompatTierModelId(modelId);
    const fallback = normalizeOpenAICompatTierModelId(fallbackModelId);
    const selected =
      this.tierMap.get(primary)
      ?? this.tierMap.get(modelId)
      ?? this.tierMap.get(fallback)
      ?? this.tierMap.get(fallbackModelId);
    if (!selected) {
      throw new Error(`No tier config available for ${modelId} or fallback ${fallbackModelId}`);
    }
    const capabilityId = resolveEndpointCapabilityId(selected.baseUrl);
    const transportAdapter = getEndpointTransportAdapter(capabilityId, { dashscope: this.dashscopeOptions });
    const telemetryFetch = createUsageTelemetryFetch(globalThis.fetch, {
      provider: transportAdapter.telemetryProviderTag,
      tier: selected.id,
      model: selected.backendModel,
      cacheDebugTraceMode: this.cacheDebugTraceMode,
      getCacheDebugTraceContext: () => this.cacheDebugTraceContext(),
    });
    const transportFetch = composeEndpointTransportFetch(
      telemetryFetch,
      transportAdapter,
      () => this.currentSessionKey,
      {
        retryPolicy: this.upstreamRetryPolicy,
        getMarkerIndices: () => this.currentSessionKey && this.prefixOptimizer
          ? this.prefixOptimizer.getMarkerIndicesForSession(this.currentSessionKey)
          : [],
      },
    );

    const upstream = createOpenAI({
      baseURL: selected.baseUrl,
      apiKey: selected.apiKey,
      fetch: transportFetch,
    });
    const provider = customProvider({
      languageModels: {
        [selected.id]: upstream.chat(selected.backendModel)
      }
    });
    const adapter = resolveAdapter(selected.backendModel, selected.baseUrl, selected.adapterHint);
    return {
      model: provider.languageModel(selected.id),
      resolvedModelId: selected.id,
      adapter
    };
  }

  getTierConfig(modelId: string): TierConfig | undefined {
    const normalized = normalizeOpenAICompatTierModelId(modelId);
    return this.tierMap.get(normalized) ?? this.tierMap.get(modelId);
  }

  resolveAdHoc(
    modelId: string,
    backendModel: string,
    baseUrl: string,
    apiKey: string,
    adapterHint?: string | null,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const capabilityId = resolveEndpointCapabilityId(baseUrl);
    const transportAdapter = getEndpointTransportAdapter(capabilityId, { dashscope: this.dashscopeOptions });
    const telemetryFetch = createUsageTelemetryFetch(globalThis.fetch, {
      provider: transportAdapter.telemetryProviderTag,
      tier: modelId,
      model: backendModel,
      cacheDebugTraceMode: this.cacheDebugTraceMode,
      getCacheDebugTraceContext: () => this.cacheDebugTraceContext(),
    });
    const transportFetch = composeEndpointTransportFetch(
      telemetryFetch,
      transportAdapter,
      () => this.currentSessionKey,
      {
        retryPolicy: this.upstreamRetryPolicy,
        getMarkerIndices: () => this.currentSessionKey && this.prefixOptimizer
          ? this.prefixOptimizer.getMarkerIndicesForSession(this.currentSessionKey)
          : [],
      },
    );
    const upstream = createOpenAI({
      baseURL: baseUrl,
      apiKey,
      fetch: transportFetch,
    });
    const provider = customProvider({
      languageModels: {
        [modelId]: upstream.chat(backendModel),
      },
    });
    const adapter = resolveAdapter(backendModel, baseUrl, adapterHint);
    return {
      model: provider.languageModel(modelId),
      resolvedModelId: modelId,
      adapter,
    };
  }
}
