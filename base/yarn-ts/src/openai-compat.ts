type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
};

export function toOpenAiUsage(usage: TokenUsage): Record<string, unknown> {
  const details: Record<string, unknown> = {
    cached_tokens: usage.cachedTokens,
  };
  if (usage.cacheCreationTokens > 0) {
    details.cache_creation_input_tokens = usage.cacheCreationTokens;
  }
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: details,
    // Legacy flat fields for backward compatibility with older clients
    cached_prompt_tokens: usage.cachedTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
  };
}

export function shouldIncludeStreamUsage(streamOptions: unknown): boolean {
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return true;
  }
  const includeUsage = (streamOptions as { include_usage?: unknown }).include_usage;
  if (typeof includeUsage === "boolean") return includeUsage;
  return true;
}
