import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveAdapter } from "./model-adapter.js";
export class SynesisProviderRegistry {
    tierMap = new Map();
    updateTiers(tiers) {
        this.tierMap.clear();
        for (const tier of tiers) {
            this.tierMap.set(tier.id, tier);
        }
    }
    getAvailableModels() {
        return Array.from(this.tierMap.keys()).map((id) => ({
            id,
            object: "model",
            owned_by: "synesis",
            created: 1704067200
        }));
    }
    resolve(modelId, fallbackModelId) {
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
    getTierConfig(modelId) {
        return this.tierMap.get(modelId);
    }
    resolveAdHoc(modelId, backendModel, baseUrl, apiKey) {
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
