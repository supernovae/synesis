import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { TierConfig } from "./admin-tier-registry.js";
import { type ModelAdapter, resolveAdapter } from "./model-adapter.js";
import { createDashScopeCacheFetch } from "./dashscope-cache-interceptor.js";

export interface DashScopeCacheOpts {
  enabled: boolean;
  maxMarkers: number;
}

export class SynesisProviderRegistry {
  private tierMap = new Map<string, TierConfig>();

  updateTiers(tiers: TierConfig[]): void {
    this.tierMap.clear();
    for (const tier of tiers) {
      this.tierMap.set(tier.id, tier);
    }
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
    dashScopeCache?: DashScopeCacheOpts,
  ): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const selected = this.tierMap.get(modelId) ?? this.tierMap.get(fallbackModelId);
    if (!selected) {
      throw new Error(`No tier config available for ${modelId} or fallback ${fallbackModelId}`);
    }
    const isDashScope = selected.baseUrl.toLowerCase().includes("dashscope");
    const wrapFetch = isDashScope && dashScopeCache?.enabled;
    if (wrapFetch) {
      console.log(JSON.stringify({
        level: 20,
        msg: "dashscope_cache_interceptor_active",
        tier: selected.id,
        baseUrl: selected.baseUrl.replace(/\/\/[^@]+@/, "//***@"),
        backendModel: selected.backendModel,
        maxMarkers: dashScopeCache!.maxMarkers,
      }));
    }
    const upstream = createOpenAI({
      baseURL: selected.baseUrl,
      apiKey: selected.apiKey,
      ...(wrapFetch ? { fetch: createDashScopeCacheFetch(globalThis.fetch, dashScopeCache!.maxMarkers) } : {}),
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
