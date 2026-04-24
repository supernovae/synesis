import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { TierConfig } from "./admin-tier-registry.js";
import { type ModelAdapter, resolveAdapter } from "./model-adapter.js";
import { createUsageTelemetryFetch } from "./usage-telemetry-fetch.js";
import type { PrefixOptimizer } from "./prefix-optimizer/index.js";
import {
  composeEndpointTransportFetch,
  type EndpointTransportRetryPolicy,
} from "./endpoint-capabilities/compose-fetch.js";
import { getEndpointTransportAdapter } from "./endpoint-capabilities/registry.js";
import { resolveEndpointCapabilityId } from "./endpoint-capabilities/resolve.js";

// DashScope explicit cache removed (Alibaba does not provide true KV/prefix caching like vLLM.
// It capped reported cached_tokens at fixed marker sizes and interfered with self-hosted
// vLLM KV reporting via broad hasNativeQwenToolParser and marker logic. We now rely on
// implicit_prefix + full SDK usage reporting for accurate variable cached tokens (80-90%
// expected on long runs with your vLLM + prefix caching + RAM).

export interface DashScopeCacheOpts {
  enabled: boolean;
  maxMarkers: number;
}

export class SynesisProviderRegistry {
  private tierMap = new Map<string, TierConfig>();
  private prefixOptimizer: PrefixOptimizer | null = null;
  private currentSessionKey: string | null = null;
  private readonly upstreamRetryPolicy: EndpointTransportRetryPolicy;

  constructor(opts?: { upstreamRetryPolicy?: EndpointTransportRetryPolicy }) {
    this.upstreamRetryPolicy = opts?.upstreamRetryPolicy ?? {
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
      jitterMs: 125,
    };
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

  getAvailableModels(): Array<{ id: string; object: "model"; owned_by: string; created: number }> {
    const models = Array.from(this.tierMap.keys()).map((id) => ({
      id,
      object: "model" as const,
      owned_by: "synesis",
      created: 1704067200
    }));
    return [
      { id: "auto", object: "model" as const, owned_by: "synesis", created: 1704067200 },
      ...models,
    ];
  }

  resolve(
    modelId: string,
    fallbackModelId: string,
    /** @deprecated ignored — DashScope explicit cache removed; kept for call-site compatibility. */
    _dashScopeCache?: DashScopeCacheOpts,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const selected = this.tierMap.get(modelId) ?? this.tierMap.get(fallbackModelId);
    if (!selected) {
      throw new Error(`No tier config available for ${modelId} or fallback ${fallbackModelId}`);
    }
    const capabilityId = resolveEndpointCapabilityId(selected.baseUrl);
    const transportAdapter = getEndpointTransportAdapter(capabilityId);
    const transportFetch = composeEndpointTransportFetch(
      globalThis.fetch,
      transportAdapter,
      () => this.currentSessionKey,
      { retryPolicy: this.upstreamRetryPolicy },
    );

    const upstream = createOpenAI({
      baseURL: selected.baseUrl,
      apiKey: selected.apiKey,
      fetch: createUsageTelemetryFetch(transportFetch, {
        provider: transportAdapter.telemetryProviderTag,
        tier: selected.id,
        model: selected.backendModel,
      }),
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
    return this.tierMap.get(modelId);
  }

  resolveAdHoc(
    modelId: string,
    backendModel: string,
    baseUrl: string,
    apiKey: string,
    adapterHint?: string | null,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const capabilityId = resolveEndpointCapabilityId(baseUrl);
    const transportAdapter = getEndpointTransportAdapter(capabilityId);
    const transportFetch = composeEndpointTransportFetch(
      globalThis.fetch,
      transportAdapter,
      () => this.currentSessionKey,
      { retryPolicy: this.upstreamRetryPolicy },
    );
    const upstream = createOpenAI({
      baseURL: baseUrl,
      apiKey,
      fetch: createUsageTelemetryFetch(transportFetch, {
        provider: transportAdapter.telemetryProviderTag,
        tier: modelId,
        model: backendModel,
      }),
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
