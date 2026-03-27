import type { LlmUsage } from "./types.js";
interface ProviderUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    prompt_cache_hit_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cached_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    costUsd?: number;
    cost_usd?: number;
}
/**
 * Normalize diverse provider usage formats into LlmUsage.
 * Handles OpenAI, Anthropic, vLLM, AI SDK, and custom provider shapes.
 */
export declare function extractUsage(raw?: ProviderUsage | null): LlmUsage;
export {};
//# sourceMappingURL=usage-extract.d.ts.map