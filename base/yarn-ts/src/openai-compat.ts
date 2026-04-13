type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
};

export function toOpenAiUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedTokens,
    },
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
