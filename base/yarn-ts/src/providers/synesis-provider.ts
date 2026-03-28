import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { TierConfig } from "./admin-tier-registry.js";
import { type ModelAdapter, resolveAdapter } from "./model-adapter.js";

export class SynesisProviderRegistry {
  private tierMap = new Map<string, TierConfig>();

  updateTiers(tiers: TierConfig[]): void {
    this.tierMap.clear();
    for (const tier of tiers) {
      this.tierMap.set(tier.id, tier);
    }
  }

  getAvailableModels(): Array<{ id: string; object: "model"; owned_by: string; created: number }> {
    return Array.from(this.tierMap.keys()).map((id) => ({
      id,
      object: "model",
      owned_by: "synesis",
      created: 1704067200
    }));
  }

  resolve(modelId: string, fallbackModelId: string): { model: unknown; resolvedModelId: string; adapter: ModelAdapter } {
    const selected = this.tierMap.get(modelId) ?? this.tierMap.get(fallbackModelId);
    if (!selected) {
      throw new Error(`No tier config available for ${modelId} or fallback ${fallbackModelId}`);
    }
    const upstream = createOpenAI({
      baseURL: selected.baseUrl,
      apiKey: selected.apiKey
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
}
