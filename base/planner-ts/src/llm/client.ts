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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  pricingRates?: PricingRates;
  response_format?: Record<string, unknown>;
  extra_body?: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  usage: LlmUsage;
}

export interface StreamDelta {
  content?: string;
  reasoning_content?: string;
}

export interface StreamResult {
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

function extractUsage(raw?: ProviderUsage, pricingRates?: PricingRates): LlmUsage {
  const base = sharedExtractUsage(raw as Record<string, unknown>);
  const rates = pricingRates ?? _pricingRates;
  const cost = computeCost(base, rates, _cachedMultiplier);
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
    timeoutMs: Number(process.env.SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS ?? 300000),
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

function buildRequestBody(request: ChatRequest, prefixCacheMode: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    max_tokens: request.max_tokens,
  };
  if (request.response_format && typeof request.response_format === "object") {
    body.response_format = request.response_format;
  }

  const extraBody: Record<string, unknown> = {};
  if (prefixCacheMode === "strict") {
    extraBody.enable_prefix_caching = true;
  }
  if (request.extra_body && typeof request.extra_body === "object") {
    Object.assign(extraBody, request.extra_body);
  }
  if (Object.keys(extraBody).length > 0) {
    body.extra_body = extraBody;
  }
  return body;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function estimateTokensFromText(text: string): number {
  // Conservative approximation for providers that omit usage in streamed mode.
  return Math.max(1, Math.ceil((text ?? "").length / 4));
}

function estimateUsage(request: ChatRequest, content: string): LlmUsage {
  const promptChars = request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = estimateTokensFromText(content);
  const base: LlmUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_prompt_tokens: 0,
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
  };
  const rates = request.pricingRates ?? _pricingRates;
  const cost = computeCost(base, rates, _cachedMultiplier);
  return { ...base, estimated_cost_usd: cost.estimated_cost_usd };
}

export async function chatCompletion(request: ChatRequest): Promise<ChatResult> {
  const { baseUrl, apiKey, timeoutMs, prefixCacheMode } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = buildRequestBody(request, prefixCacheMode);
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty content");
    const usage = extractUsage(data.usage, request.pricingRates);
    return {
      content,
      usage: usage.total_tokens > 0 ? usage : estimateUsage(request, content),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming variant — yields token deltas as they arrive from the provider.
 * Returns accumulated content + usage when the stream completes.
 *
 * The caller provides an `onDelta` callback that receives each delta
 * synchronously as it is parsed, enabling real-time SSE forwarding.
 */
export async function chatCompletionStream(
  request: ChatRequest,
  onDelta: (delta: StreamDelta) => void,
): Promise<StreamResult> {
  const { baseUrl, apiKey, timeoutMs, prefixCacheMode } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs * 4);
  try {
    const body = buildRequestBody(request, prefixCacheMode);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const contentParts: string[] = [];
    let finalUsage: LlmUsage = { ...ZERO_USAGE };

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        if (choices?.[0]) {
          const delta = choices[0].delta as Record<string, unknown> | undefined;
          if (delta) {
            const content = typeof delta.content === "string" ? delta.content : undefined;
            const rc =
              typeof delta.reasoning_content === "string"
                ? delta.reasoning_content
                : typeof (delta.additional_kwargs as Record<string, unknown>)?.reasoning_content === "string"
                  ? (delta.additional_kwargs as Record<string, unknown>).reasoning_content as string
                  : undefined;

            if (content) contentParts.push(content);
            if (content || rc) {
              try { onDelta({ content, reasoning_content: rc }); } catch { /* write to closed stream */ }
            }
          }
        }

        if (parsed.usage) {
          finalUsage = extractUsage(parsed.usage as ProviderUsage, request.pricingRates);
        }
      }
    }

    const fullContent = contentParts.join("");
    if (!fullContent) throw new Error("LLM stream returned empty content");

    return {
      content: fullContent,
      usage: finalUsage.total_tokens > 0 ? finalUsage : estimateUsage(request, fullContent),
    };
  } finally {
    clearTimeout(timer);
  }
}
