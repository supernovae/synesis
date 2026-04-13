type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
};

export function toOpenAiUsage(usage: TokenUsage): Record<string, number> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
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
