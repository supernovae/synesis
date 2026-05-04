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

export type AiSdkJsonResponseFormat =
  | { type: "json" }
  | { type: "json"; schema: Record<string, unknown>; name?: string; description?: string; strict?: boolean };

export function toAiSdkJsonResponseFormat(responseFormat: unknown): AiSdkJsonResponseFormat | undefined {
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    return undefined;
  }
  const rf = responseFormat as Record<string, unknown>;
  if (rf.type === "json_object") {
    return { type: "json" };
  }
  if (rf.type !== "json_schema") {
    return undefined;
  }
  const jsonSchemaConfig = rf.json_schema;
  if (!jsonSchemaConfig || typeof jsonSchemaConfig !== "object" || Array.isArray(jsonSchemaConfig)) {
    return undefined;
  }
  const cfg = jsonSchemaConfig as Record<string, unknown>;
  const schema = cfg.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  return {
    type: "json",
    schema: schema as Record<string, unknown>,
    ...(typeof cfg.name === "string" && cfg.name.trim() ? { name: cfg.name } : {}),
    ...(typeof cfg.description === "string" && cfg.description.trim() ? { description: cfg.description } : {}),
    ...(typeof cfg.strict === "boolean" ? { strict: cfg.strict } : {}),
  };
}
