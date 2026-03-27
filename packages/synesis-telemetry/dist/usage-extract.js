import { ZERO_USAGE } from "./cost.js";
/**
 * Normalize diverse provider usage formats into LlmUsage.
 * Handles OpenAI, Anthropic, vLLM, AI SDK, and custom provider shapes.
 */
export function extractUsage(raw) {
    if (!raw)
        return { ...ZERO_USAGE };
    const prompt = Number(raw.prompt_tokens ?? raw.inputTokens ?? raw.input_tokens ?? 0);
    const completion = Number(raw.completion_tokens ?? raw.outputTokens ?? raw.output_tokens ?? 0);
    const total = Number(raw.total_tokens ?? 0) || prompt + completion;
    const cached = Number(raw.prompt_tokens_details?.cached_tokens ??
        raw.cached_tokens ??
        raw.cachedInputTokens ??
        raw.cached_input_tokens ??
        raw.prompt_cache_hit_tokens ??
        0);
    const actualCost = Number(raw.costUsd ?? raw.cost_usd ?? 0);
    return {
        prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
        completion_tokens: Number.isFinite(completion) ? completion : 0,
        total_tokens: Number.isFinite(total) ? total : 0,
        cached_prompt_tokens: Number.isFinite(cached) ? cached : 0,
        estimated_cost_usd: 0,
        actual_cost_usd: Number.isFinite(actualCost) ? actualCost : 0,
    };
}
//# sourceMappingURL=usage-extract.js.map