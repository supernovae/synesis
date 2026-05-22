import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, streamText, type JSONValue, type LanguageModelUsage, type ModelMessage } from "ai";
import type { ZodType } from "zod";
import {
  type LlmUsage,
  type PricingRates,
  ZERO_USAGE,
  mergeUsage,
  extractUsage as sharedExtractUsage,
  computeCost,
} from "@synesis/telemetry";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { getLlmRoute, hasLlmRoutes, type LlmRoute } from "../public-model-catalog.js";

export type { LlmUsage };
export { ZERO_USAGE, mergeUsage };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OpenAICompatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export interface StructuredOutputRequest {
  schema: ZodType;
  name?: string;
  description?: string;
  /** OpenAI strict JSON schema rejects optional fields; planner schemas intentionally use defaults. */
  strictJsonSchema?: boolean;
}

export interface ChatRequest {
  model: string;
  route?: LlmRoute;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  enable_thinking?: boolean;
  reasoning_effort?: string;
  stop?: string | string[];
  seed?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  tools?: unknown[];
  tool_choice?: "none" | "auto" | "required" | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  pricingRates?: PricingRates;
  response_format?: Record<string, unknown>;
  structuredOutput?: StructuredOutputRequest;
  extra_body?: Record<string, unknown>;
  request_id?: string;
  authz_trace_id?: string;
  traceparent?: string;
}

export interface ChatResult {
  content: string;
  usage: LlmUsage;
}

export interface OpenAICompatChatRequest extends Omit<ChatRequest, "messages" | "structuredOutput"> {
  messages: OpenAICompatMessage[];
  stream?: boolean;
  stream_options?: unknown;
}

export interface OpenAICompatChatResult {
  body: Record<string, unknown>;
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

type AiProviderOptions = Record<string, Record<string, JSONValue>>;

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

function usageFromSdk(usage: LanguageModelUsage | undefined, pricingRates?: PricingRates): LlmUsage {
  const raw = (usage?.raw ?? {}) as Record<string, unknown>;
  const promptTokens =
    typeof usage?.inputTokens === "number" ? usage.inputTokens : Number(raw.prompt_tokens ?? 0);
  const completionTokens =
    typeof usage?.outputTokens === "number" ? usage.outputTokens : Number(raw.completion_tokens ?? 0);
  const totalTokens =
    typeof usage?.totalTokens === "number" ? usage.totalTokens : Number(raw.total_tokens ?? promptTokens + completionTokens);
  const cachedTokens =
    usage?.inputTokenDetails?.cacheReadTokens
    ?? usage?.cachedInputTokens
    ?? (raw.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
    ?? Number(raw.cached_tokens ?? 0);

  return extractUsage({
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    cached_tokens: Number.isFinite(cachedTokens) ? cachedTokens : 0,
  }, pricingRates);
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

interface ResolvedLlmTarget {
  model: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  route?: LlmRoute;
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

function readRouteApiKey(route: LlmRoute | undefined, fallbackApiKey: string): string {
  const apiKeyEnv = (route?.apiKeyEnv ?? "").trim();
  if (!apiKeyEnv) return fallbackApiKey;
  return (process.env[apiKeyEnv] ?? "").trim();
}

function validateBaseUrl(raw: string, provider: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("LLM route has no base URL");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("LLM route has an invalid base URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("LLM route base URL must not contain credentials");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("LLM route base URL must use http or https");
  }
  const host = parsed.hostname.toLowerCase();
  const blockedHosts = new Set(["169.254.169.254", "metadata.google.internal"]);
  if (blockedHosts.has(host)) {
    throw new Error(`LLM route for provider ${provider || "unknown"} targets a blocked metadata host`);
  }
  return trimmed.replace(/\/$/, "");
}

function resolvedGenerationParams(route: LlmRoute | undefined): Partial<ChatRequest> {
  const raw = route?.generationParams;
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<ChatRequest> = {};
  const numberParam = (key: keyof ChatRequest): number | undefined => {
    const value = raw[key as string];
    const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
    return num != null && Number.isFinite(num) ? num : undefined;
  };
  const maxTokens = numberParam("max_tokens");
  if (maxTokens != null && maxTokens > 0) out.max_tokens = Math.trunc(maxTokens);
  const temperature = numberParam("temperature");
  if (temperature != null && temperature >= 0) out.temperature = temperature;
  const topP = numberParam("top_p");
  if (topP != null && topP >= 0 && topP <= 1) out.top_p = topP;
  const topK = numberParam("top_k");
  if (topK != null && topK >= 0) out.top_k = Math.trunc(topK);
  const minP = numberParam("min_p");
  if (minP != null && minP >= 0 && minP <= 1) out.min_p = minP;
  const presencePenalty = numberParam("presence_penalty");
  if (presencePenalty != null) out.presence_penalty = presencePenalty;
  const frequencyPenalty = numberParam("frequency_penalty");
  if (frequencyPenalty != null) out.frequency_penalty = frequencyPenalty;
  const repetitionPenalty = numberParam("repetition_penalty");
  if (repetitionPenalty != null && repetitionPenalty >= 0) out.repetition_penalty = repetitionPenalty;
  if (typeof raw.enable_thinking === "boolean") out.enable_thinking = raw.enable_thinking;
  if (typeof raw.reasoning_effort === "string" && raw.reasoning_effort.trim()) {
    out.reasoning_effort = raw.reasoning_effort.trim();
  }
  if (typeof raw.stop === "string" || (Array.isArray(raw.stop) && raw.stop.every((item) => typeof item === "string"))) {
    out.stop = raw.stop;
  }
  const seed = numberParam("seed");
  if (seed != null) out.seed = Math.trunc(seed);
  if (raw.logit_bias && typeof raw.logit_bias === "object" && !Array.isArray(raw.logit_bias)) {
    out.logit_bias = raw.logit_bias as Record<string, number>;
  }
  if (typeof raw.logprobs === "boolean") out.logprobs = raw.logprobs;
  const topLogprobs = numberParam("top_logprobs");
  if (topLogprobs != null && topLogprobs >= 0) out.top_logprobs = Math.trunc(topLogprobs);
  const n = numberParam("n");
  if (n != null && n > 0) out.n = Math.trunc(n);
  if (Array.isArray(raw.tools)) out.tools = raw.tools;
  if (
    raw.tool_choice === "none"
    || raw.tool_choice === "auto"
    || raw.tool_choice === "required"
    || (raw.tool_choice && typeof raw.tool_choice === "object" && !Array.isArray(raw.tool_choice))
  ) {
    out.tool_choice = raw.tool_choice as ChatRequest["tool_choice"];
  }
  if (typeof raw.parallel_tool_calls === "boolean") out.parallel_tool_calls = raw.parallel_tool_calls;
  if (raw.extra_body && typeof raw.extra_body === "object" && !Array.isArray(raw.extra_body)) {
    out.extra_body = raw.extra_body as Record<string, unknown>;
  }
  return out;
}

function mergeRouteDefaults(request: ChatRequest, route: LlmRoute | undefined): ChatRequest {
  const defaults = resolvedGenerationParams(route);
  return { ...defaults, ...request };
}

function resolveLlmTarget(request: ChatRequest, config: LlmConfig): ResolvedLlmTarget {
  const route = request.route ?? getLlmRoute(request.model);
  const provider = (route?.provider ?? "").trim();
  const baseUrl = validateBaseUrl((route?.baseUrl ?? config.baseUrl).trim(), provider);
  const model = (route?.model ?? request.model).trim();
  if (!model) throw new Error("LLM route has no model");
  return {
    model,
    baseUrl,
    apiKey: readRouteApiKey(route, config.apiKey),
    provider,
    route,
  };
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
  return llmEnabled() && (baseUrl.length > 0 || hasLlmRoutes());
}

function addExtraBodyOption(extraBody: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) extraBody[key] = value;
}

function mutateOpenAICompatBody(body: BodyInit | null | undefined, request: ChatRequest, prefixCacheMode: string): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

  if (request.response_format && !request.structuredOutput) parsed.response_format = request.response_format;
  if (request.n !== undefined) parsed.n = request.n;
  if (request.tools !== undefined) parsed.tools = request.tools;
  if (request.tool_choice !== undefined) parsed.tool_choice = request.tool_choice;
  if (request.parallel_tool_calls !== undefined) parsed.parallel_tool_calls = request.parallel_tool_calls;
  if (request.logit_bias !== undefined) parsed.logit_bias = request.logit_bias;
  if (request.logprobs !== undefined) parsed.logprobs = request.logprobs;
  if (request.top_logprobs !== undefined) parsed.top_logprobs = request.top_logprobs;

  const existingExtraBody =
    parsed.extra_body && typeof parsed.extra_body === "object" && !Array.isArray(parsed.extra_body)
      ? parsed.extra_body as Record<string, unknown>
      : {};
  const extraBody = { ...existingExtraBody };
  addExtraBodyOption(extraBody, "top_k", request.top_k);
  addExtraBodyOption(extraBody, "min_p", request.min_p);
  addExtraBodyOption(extraBody, "repetition_penalty", request.repetition_penalty);
  addExtraBodyOption(extraBody, "enable_thinking", request.enable_thinking);
  if (prefixCacheMode === "strict") {
    extraBody.enable_prefix_caching = true;
  }
  if (request.extra_body && typeof request.extra_body === "object") {
    Object.assign(extraBody, request.extra_body);
  }
  if (Object.keys(extraBody).length > 0) parsed.extra_body = extraBody;

  return JSON.stringify(parsed);
}

function buildHeaders(request?: { request_id?: string; authz_trace_id?: string; traceparent?: string }): Record<string, string> {
  return {
    ...(request?.request_id ? { "x-request-id": request.request_id } : {}),
    ...(request?.authz_trace_id ? { "x-synesis-authz-trace-id": request.authz_trace_id } : {}),
    ...(request?.traceparent ? { traceparent: request.traceparent } : {}),
  };
}

function buildOpenAICompatHeaders(
  target: ResolvedLlmTarget,
  request?: { request_id?: string; authz_trace_id?: string; traceparent?: string },
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${target.apiKey || "unused"}`,
    ...buildHeaders(request),
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function openAICompatBody(
  request: OpenAICompatChatRequest,
  model: string,
  prefixCacheMode: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages,
  };
  if (request.stream !== undefined) body.stream = request.stream;
  if (request.stream_options !== undefined) body.stream_options = request.stream_options;
  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
  if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
  if (request.stop !== undefined) body.stop = request.stop;
  if (request.seed !== undefined) body.seed = request.seed;
  if (request.logit_bias !== undefined) body.logit_bias = request.logit_bias;
  if (request.logprobs !== undefined) body.logprobs = request.logprobs;
  if (request.top_logprobs !== undefined) body.top_logprobs = request.top_logprobs;
  if (request.n !== undefined) body.n = request.n;
  if (request.tools !== undefined) body.tools = request.tools;
  if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
  if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls;
  if (request.response_format !== undefined) body.response_format = request.response_format;

  const extraBody =
    request.extra_body && typeof request.extra_body === "object"
      ? { ...request.extra_body }
      : {};
  addExtraBodyOption(extraBody, "top_k", request.top_k);
  addExtraBodyOption(extraBody, "min_p", request.min_p);
  addExtraBodyOption(extraBody, "repetition_penalty", request.repetition_penalty);
  addExtraBodyOption(extraBody, "enable_thinking", request.enable_thinking);
  if (prefixCacheMode === "strict") {
    extraBody.enable_prefix_caching = true;
  }
  if (Object.keys(extraBody).length > 0) body.extra_body = extraBody;
  return body;
}

function buildProviderOptions(request: ChatRequest): AiProviderOptions | undefined {
  const openai: Record<string, JSONValue> = {};
  if (request.reasoning_effort) openai.reasoningEffort = request.reasoning_effort;
  if (request.logit_bias) openai.logitBias = request.logit_bias;
  if (request.logprobs !== undefined) openai.logprobs = request.logprobs;
  if (request.top_logprobs !== undefined) openai.topLogprobs = request.top_logprobs;
  if (request.parallel_tool_calls !== undefined) openai.parallelToolCalls = request.parallel_tool_calls;
  if (request.structuredOutput) openai.strictJsonSchema = request.structuredOutput.strictJsonSchema ?? false;
  return Object.keys(openai).length > 0 ? { openai } : undefined;
}

function stopSequences(stop: string | string[] | undefined): string[] | undefined {
  if (typeof stop === "string") return [stop];
  return stop;
}

function asModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content })) as ModelMessage[];
}

function estimateTokensFromText(text: string): number {
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

function createAiSdkModel(target: ResolvedLlmTarget, request: ChatRequest, config: LlmConfig) {
  const fetchWithResilience = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return resilientFetch(url, {
      ...init,
      body: mutateOpenAICompatBody(init?.body, request, config.prefixCacheMode),
    }, {
      modelId: `${target.provider}:${target.model}:${target.baseUrl}`,
      timeoutMs: config.timeoutMs,
      retryMaxAttempts: config.retryMaxAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      circuitBreakerRecoveryTimeoutMs: config.circuitBreakerRecoveryTimeoutMs,
      externalSignal: init?.signal ?? undefined,
    });
  };

  const provider = createOpenAI({
    baseURL: target.baseUrl,
    apiKey: target.apiKey || "unused",
    name: target.provider || "openai",
    fetch: fetchWithResilience,
  });
  return provider.chat(target.model);
}

function commonGenerateOptions(request: ChatRequest, model: ReturnType<ReturnType<typeof createOpenAI>["chat"]> | unknown, abortSignal: AbortSignal) {
  return {
    model: model as never,
    messages: asModelMessages(request.messages),
    maxOutputTokens: request.max_tokens,
    temperature: request.temperature ?? 0,
    topP: request.top_p,
    presencePenalty: request.presence_penalty,
    frequencyPenalty: request.frequency_penalty,
    stopSequences: stopSequences(request.stop),
    seed: request.seed,
    headers: buildHeaders(request),
    providerOptions: buildProviderOptions(request),
    abortSignal,
    maxRetries: 0,
  };
}

export async function chatCompletion(request: ChatRequest): Promise<ChatResult> {
  const config = llmConfig();
  if (!llmEnabled()) {
    throw new Error("LLM is not enabled");
  }

  const target = resolveLlmTarget(request, config);
  const effectiveRequest = mergeRouteDefaults({ ...request, model: target.model }, target.route);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);
  try {
    const model = createAiSdkModel(target, effectiveRequest, config);
    const output = effectiveRequest.structuredOutput
      ? Output.object({
          schema: effectiveRequest.structuredOutput.schema,
          name: effectiveRequest.structuredOutput.name,
          description: effectiveRequest.structuredOutput.description,
        })
      : undefined;

    const result = await generateText({
      ...commonGenerateOptions(effectiveRequest, model, controller.signal),
      ...(output ? { output } : {}),
    });
    const content = output ? JSON.stringify(result.output) : result.text;
    if (!content) throw new Error("LLM returned empty content");
    const usage = usageFromSdk(result.totalUsage ?? result.usage, effectiveRequest.pricingRates);
    return {
      content,
      usage: usage.total_tokens > 0 ? usage : estimateUsage(effectiveRequest, content),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletionOpenAICompat(request: OpenAICompatChatRequest): Promise<OpenAICompatChatResult> {
  const config = llmConfig();
  if (!llmEnabled()) {
    throw new Error("LLM is not enabled");
  }

  const target = resolveLlmTarget(request as unknown as ChatRequest, config);
  const effectiveRequest = mergeRouteDefaults(
    { ...(request as unknown as ChatRequest), model: target.model },
    target.route,
  ) as OpenAICompatChatRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);
  try {
    const resp = await resilientFetch(chatCompletionsUrl(target.baseUrl), {
      method: "POST",
      headers: buildOpenAICompatHeaders(target, effectiveRequest),
      body: JSON.stringify(openAICompatBody(effectiveRequest, target.model, config.prefixCacheMode)),
      signal: controller.signal,
    }, {
      modelId: `${target.provider}:${target.model}:${target.baseUrl}`,
      timeoutMs: config.timeoutMs,
      retryMaxAttempts: config.retryMaxAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      circuitBreakerRecoveryTimeoutMs: config.circuitBreakerRecoveryTimeoutMs,
      externalSignal: controller.signal,
    });
    const body = await resp.json() as Record<string, unknown>;
    const rawUsage = body.usage && typeof body.usage === "object" ? body.usage as ProviderUsage : undefined;
    return {
      body,
      usage: extractUsage(rawUsage, effectiveRequest.pricingRates),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletionOpenAICompatStream(request: OpenAICompatChatRequest): Promise<Response> {
  const config = llmConfig();
  if (!llmEnabled()) {
    throw new Error("LLM is not enabled");
  }

  const target = resolveLlmTarget(request as unknown as ChatRequest, config);
  const streamRequest = { ...(request as unknown as ChatRequest), model: target.model, stream: true } as ChatRequest;
  const effectiveRequest = mergeRouteDefaults(
    streamRequest,
    target.route,
  ) as OpenAICompatChatRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);
  try {
    return await resilientFetch(chatCompletionsUrl(target.baseUrl), {
      method: "POST",
      headers: buildOpenAICompatHeaders(target, effectiveRequest),
      body: JSON.stringify(
        openAICompatBody({ ...effectiveRequest, stream: true }, target.model, config.prefixCacheMode),
      ),
      signal: controller.signal,
    }, {
      modelId: `${target.provider}:${target.model}:${target.baseUrl}`,
      timeoutMs: config.timeoutMs,
      retryMaxAttempts: config.retryMaxAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      circuitBreakerRecoveryTimeoutMs: config.circuitBreakerRecoveryTimeoutMs,
      externalSignal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletionStream(
  request: ChatRequest,
  onDelta: (delta: StreamDelta) => void,
): Promise<StreamResult> {
  const config = llmConfig();
  if (!llmEnabled()) {
    throw new Error("LLM is not enabled");
  }
  const target = resolveLlmTarget(request, config);
  const effectiveRequest = mergeRouteDefaults({ ...request, model: target.model }, target.route);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);
  try {
    const model = createAiSdkModel(target, effectiveRequest, config);
    const streamed = streamText({
      ...commonGenerateOptions(effectiveRequest, model, controller.signal),
      timeout: { totalMs: config.timeoutMs * 4, chunkMs: config.timeoutMs },
    });

    const contentParts: string[] = [];
    let finalUsage: LlmUsage = { ...ZERO_USAGE };

    for await (const part of streamed.fullStream) {
      if (part.type === "text-delta") {
        contentParts.push(part.text);
        try { onDelta({ content: part.text }); } catch { /* write to closed stream */ }
      } else if (part.type === "reasoning-delta") {
        try { onDelta({ reasoning_content: part.text }); } catch { /* write to closed stream */ }
      } else if (part.type === "finish") {
        finalUsage = usageFromSdk(part.totalUsage, effectiveRequest.pricingRates);
      }
    }

    const fullContent = contentParts.join("");
    if (!fullContent) throw new Error("LLM stream returned empty content");

    return {
      content: fullContent,
      usage: finalUsage.total_tokens > 0 ? finalUsage : estimateUsage(effectiveRequest, fullContent),
    };
  } finally {
    clearTimeout(timer);
  }
}
