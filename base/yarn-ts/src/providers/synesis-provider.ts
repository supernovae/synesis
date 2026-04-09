import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { TierConfig } from "./admin-tier-registry.js";
import { type ModelAdapter, resolveAdapter } from "./model-adapter.js";
import { createUsageTelemetryFetch } from "./usage-telemetry-fetch.js";
import type { PrefixOptimizer } from "./prefix-optimizer/index.js";

export interface DashScopeCacheOpts {
  enabled: boolean;
  maxMarkers: number;
}

export class SynesisProviderRegistry {
  private tierMap = new Map<string, TierConfig>();
  private prefixOptimizer: PrefixOptimizer | null = null;
  private currentSessionKey: string | null = null;

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
    _dashScopeCache?: DashScopeCacheOpts,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const selected = this.tierMap.get(modelId) ?? this.tierMap.get(fallbackModelId);
    if (!selected) {
      throw new Error(`No tier config available for ${modelId} or fallback ${fallbackModelId}`);
    }
    // Detect provider type for telemetry tagging
    const providerTag = selected.baseUrl.toLowerCase().includes("dashscope") ? "dashscope"
      : selected.baseUrl.toLowerCase().includes("openrouter") ? "openrouter"
      : selected.baseUrl.toLowerCase().includes("localhost") || selected.baseUrl.toLowerCase().includes("vllm") ? "vllm"
      : "generic";

    const upstream = createOpenAI({
      baseURL: selected.baseUrl,
      apiKey: selected.apiKey,
      fetch: createUsageTelemetryFetch(globalThis.fetch, {
        provider: providerTag,
        tier: selected.id,
        model: selected.backendModel,
      }),
    });
    const provider = customProvider({
      languageModels: {
        [selected.id]: upstream.chat(selected.backendModel)
      }
    });
    const adapter = resolveAdapter(selected.backendModel, selected.baseUrl);
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
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const upstream = createOpenAI({
      baseURL: baseUrl,
      apiKey,
    });
    const provider = customProvider({
      languageModels: {
        [modelId]: upstream.chat(backendModel),
      },
    });
    const adapter = resolveAdapter(backendModel, baseUrl);
    return {
      model: provider.languageModel(modelId),
      resolvedModelId: modelId,
      adapter,
    };
  }
}
