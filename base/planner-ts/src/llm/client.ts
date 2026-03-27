type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
}

export const ZERO_USAGE: LlmUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_prompt_tokens: 0
};

export function mergeUsage(a: LlmUsage | undefined, b: LlmUsage): LlmUsage {
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + b.prompt_tokens,
    completion_tokens: (a?.completion_tokens ?? 0) + b.completion_tokens,
    total_tokens: (a?.total_tokens ?? 0) + b.total_tokens,
    cached_prompt_tokens: (a?.cached_prompt_tokens ?? 0) + b.cached_prompt_tokens
  };
}

export interface ChatResult {
  content: string;
  usage: LlmUsage;
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: ProviderUsage;
}

function extractUsage(raw?: ProviderUsage): LlmUsage {
  const prompt = raw?.prompt_tokens ?? 0;
  const completion = raw?.completion_tokens ?? 0;
  const total = raw?.total_tokens ?? prompt + completion;
  const cached =
    raw?.prompt_tokens_details?.cached_tokens ??
    raw?.cached_tokens ??
    raw?.prompt_cache_hit_tokens ??
    0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_prompt_tokens: cached
  };
}

function llmEnabled(): boolean {
  return (process.env.SYNESIS_PLANNER_TS_LLM_ENABLED ?? "false").toLowerCase() === "true";
}

function llmConfig() {
  return {
    baseUrl: (process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL ?? "").trim(),
    apiKey: (process.env.SYNESIS_PLANNER_TS_LLM_API_KEY ?? "").trim(),
    timeoutMs: Number(process.env.SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS ?? 15000),
    prefixCacheMode: (process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE ?? "auto") as
      | "auto"
      | "strict"
      | "disabled"
  };
}

export function isLlmAvailable(): boolean {
  const { baseUrl } = llmConfig();
  return llmEnabled() && baseUrl.length > 0;
}

export async function chatCompletion(request: ChatRequest): Promise<ChatResult> {
  const { baseUrl, apiKey, timeoutMs, prefixCacheMode } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.max_tokens
    };

    if (prefixCacheMode === "strict") {
      body.extra_body = { enable_prefix_caching: true };
    }

    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty content");
    return {
      content,
      usage: extractUsage(data.usage)
    };
  } finally {
    clearTimeout(timer);
  }
}
