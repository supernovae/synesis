import {
  type LlmUsage,
  type PricingRates,
  ZERO_USAGE,
  mergeUsage,
  extractUsage as sharedExtractUsage,
  computeCost,
} from "@synesis/telemetry";

export type { LlmUsage };
export { ZERO_USAGE, mergeUsage };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
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

let _pricingRates: PricingRates = {
  input_per_million: 0,
  output_per_million: 0,
  cached_input_per_million: null,
};
let _cachedMultiplier = 0.1;

export function setPricingContext(rates: PricingRates, cachedMultiplier: number): void {
  _pricingRates = rates;
  _cachedMultiplier = cachedMultiplier;
}

function extractUsage(raw?: ProviderUsage): LlmUsage {
  const base = sharedExtractUsage(raw as Record<string, unknown>);
  const cost = computeCost(base, _pricingRates, _cachedMultiplier);
  return {
    ...base,
    estimated_cost_usd: cost.estimated_cost_usd,
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
