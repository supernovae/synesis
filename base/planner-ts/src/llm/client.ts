import {
  type LlmUsage,
  type PricingRates,
  ZERO_USAGE,
  mergeUsage,
  extractUsage as sharedExtractUsage,
  computeCost,
} from "@synesis/telemetry";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";

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
  request_id?: string;
  authz_trace_id?: string;
  traceparent?: string;
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

interface LlmClientError extends Error {
  statusCode?: number;
  retryAfterSeconds?: number;
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

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  prefixCacheMode: "auto" | "strict" | "disabled";
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerRecoveryTimeoutMs: number;
  circuitBreakerHalfOpenMax: number;
}

let _breakerConfigKey = "";
let _breakerRegistry = new CircuitBreakerRegistry();

function llmConfig(): LlmConfig {
  return {
    baseUrl: (process.env.SYNESIS_PLANNER_TS_LLM_BASE_URL ?? "").trim(),
    apiKey: (process.env.SYNESIS_PLANNER_TS_LLM_API_KEY ?? "").trim(),
    timeoutMs: Number(process.env.SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS ?? 300000),
    prefixCacheMode: (process.env.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE ?? "auto") as
      | "auto"
      | "strict"
      | "disabled",
    retryMaxAttempts: Math.max(1, Number(process.env.SYNESIS_PLANNER_TS_LLM_RETRY_MAX_ATTEMPTS ?? 3)),
    retryBaseDelayMs: Math.max(50, Number(process.env.SYNESIS_PLANNER_TS_LLM_RETRY_BASE_DELAY_MS ?? 1000)),
    circuitBreakerFailureThreshold: Math.max(1, Number(process.env.SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 5)),
    circuitBreakerRecoveryTimeoutMs: Math.max(1000, Number(process.env.SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS ?? 60000)),
    circuitBreakerHalfOpenMax: Math.max(1, Number(process.env.SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_HALF_OPEN_MAX ?? 1)),
  };
}

function getBreakerRegistry(config: LlmConfig): CircuitBreakerRegistry {
  const key = [
    config.circuitBreakerFailureThreshold,
    config.circuitBreakerRecoveryTimeoutMs,
    config.circuitBreakerHalfOpenMax,
  ].join(":");
  if (key !== _breakerConfigKey) {
    _breakerConfigKey = key;
    _breakerRegistry = new CircuitBreakerRegistry({
      failureThreshold: config.circuitBreakerFailureThreshold,
      recoveryTimeoutMs: config.circuitBreakerRecoveryTimeoutMs,
      halfOpenMax: config.circuitBreakerHalfOpenMax,
    });
  }
  return _breakerRegistry;
}

class CircuitBreakerOpenError extends Error implements LlmClientError {
  statusCode = 503;
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Circuit breaker open for upstream model service");
    this.name = "CircuitBreakerOpenError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function isRetriableError(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed")
    || message.includes("network")
    || message.includes("socket")
    || message.includes("econn")
  );
}

function backoffDelayMs(baseMs: number, attemptIndex: number): number {
  const exp = Math.min(4, attemptIndex);
  return Math.min(10_000, baseMs * (2 ** exp));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resilientFetch(
  url: string,
  init: RequestInit,
  opts: {
    modelId: string;
    orgId?: string;
    timeoutMs: number;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    circuitBreakerRecoveryTimeoutMs: number;
    externalSignal?: AbortSignal;
  },
): Promise<Response> {
  const breaker = getBreakerRegistry(llmConfig());
  const orgId = opts.orgId ?? "";
  const breakerAllowed = breaker.allowRequest(opts.modelId, orgId);
  if (!breakerAllowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(opts.circuitBreakerRecoveryTimeoutMs / 1000));
    throw new CircuitBreakerOpenError(retryAfterSeconds);
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < opts.retryMaxAttempts; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      const signal = opts.externalSignal
        ? AbortSignal.any([opts.externalSignal, timeoutSignal])
        : timeoutSignal;
      const resp = await fetch(url, { ...init, signal });
      if (resp.ok) {
        breaker.recordSuccess(opts.modelId, orgId);
        return resp;
      }

      if (!isRetriableStatus(resp.status)) {
        const text = await resp.text();
        const err = new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
        (err as LlmClientError).statusCode = resp.status;
        throw err;
      }

      const text = await resp.text();
      lastError = new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
      breaker.recordFailure(opts.modelId, orgId);
      if (attempt < opts.retryMaxAttempts - 1) {
        await sleep(backoffDelayMs(opts.retryBaseDelayMs, attempt));
        continue;
      }
      throw lastError;
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) throw error;
      if (error instanceof Error && (error as LlmClientError).statusCode && !isRetriableStatus((error as LlmClientError).statusCode ?? 0)) {
        throw error;
      }
      if (!isRetriableError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      breaker.recordFailure(opts.modelId, orgId);
      if (attempt < opts.retryMaxAttempts - 1) {
        await sleep(backoffDelayMs(opts.retryBaseDelayMs, attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("LLM request failed");
}

export function getLlmResilienceStats(): {
  breaker: ReturnType<CircuitBreakerRegistry["getStats"]>;
} {
  const config = llmConfig();
  return {
    breaker: getBreakerRegistry(config).getStats(),
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

function buildHeaders(apiKey: string, request?: ChatRequest): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(request?.request_id ? { "x-request-id": request.request_id } : {}),
    ...(request?.authz_trace_id ? { "x-synesis-authz-trace-id": request.authz_trace_id } : {}),
    ...(request?.traceparent ? { traceparent: request.traceparent } : {}),
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
  const {
    baseUrl,
    apiKey,
    timeoutMs,
    prefixCacheMode,
    retryMaxAttempts,
    retryBaseDelayMs,
    circuitBreakerRecoveryTimeoutMs,
  } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const body = buildRequestBody(request, prefixCacheMode);
  const resp = await resilientFetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey, request),
    body: JSON.stringify(body),
  }, {
    modelId: request.model,
    timeoutMs,
    retryMaxAttempts,
    retryBaseDelayMs,
    circuitBreakerRecoveryTimeoutMs,
  });
  const data = (await resp.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty content");
  const usage = extractUsage(data.usage, request.pricingRates);
  return {
    content,
    usage: usage.total_tokens > 0 ? usage : estimateUsage(request, content),
  };
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
  const {
    baseUrl,
    apiKey,
    timeoutMs,
    prefixCacheMode,
    retryMaxAttempts,
    retryBaseDelayMs,
    circuitBreakerRecoveryTimeoutMs,
  } = llmConfig();
  if (!isLlmAvailable()) {
    throw new Error("LLM is not enabled");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs * 4);
  try {
    const body = buildRequestBody(request, prefixCacheMode);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const resp = await resilientFetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(apiKey, request),
      body: JSON.stringify(body),
    }, {
      modelId: request.model,
      timeoutMs,
      retryMaxAttempts,
      retryBaseDelayMs,
      circuitBreakerRecoveryTimeoutMs,
      externalSignal: controller.signal,
    });

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
