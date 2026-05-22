import { annotateCacheBreakpoints, detectCacheStrategy, type CacheStrategy } from "../context/provider-cache-hints.js";
import { extractUsage } from "@synesis/telemetry";
import { getEndpointTransportAdapter } from "../providers/endpoint-capabilities/registry.js";
import type { EndpointCapabilityId } from "../providers/endpoint-capabilities/types.js";
import { PrefixOptimizer, type OptimizedRequest } from "../providers/prefix-optimizer/index.js";
import type { ChatMessage, MarkerBackend, ToolDefinition } from "../providers/prefix-optimizer/types.js";
import {
  buildTokenEconomicsDecision,
  inferProviderCacheStrategy,
  type ProviderCacheStrategy,
  type TokenEconomicsDecision,
} from "./token-economics.js";

export interface ProviderCacheCanaryCase {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  providerTag: string;
  endpointCapability: EndpointCapabilityId | "none";
  markerBackend: MarkerBackend;
  expectedProviderStrategy: ProviderCacheStrategy;
  expectedHintStrategy?: CacheStrategy;
  requiresExplicitMarkers: boolean;
  premiumCache: boolean;
  minPrefixStableBytes: number;
}

export interface ProviderCacheCanaryAnnotations {
  dashscopeMessageMarkers: number;
  dashscopeToolMarkers: number;
  anthropicBreakpoints: number;
}

export interface ProviderCacheCanaryResult {
  id: string;
  displayName: string;
  passed: boolean;
  failures: string[];
  markerBackend: MarkerBackend;
  providerStrategy: ProviderCacheStrategy;
  cacheHintStrategy: CacheStrategy;
  prefixStableBytes: number;
  markerIndicesFirst: number[];
  markerIndicesSecond: number[];
  markerStable: boolean;
  annotations: ProviderCacheCanaryAnnotations;
  decisions: {
    hit: TokenEconomicsDecision;
    miss: TokenEconomicsDecision;
    writeWithoutRead?: TokenEconomicsDecision;
  };
}

export interface ProviderCacheCanarySummary {
  passed: boolean;
  total: number;
  failed: number;
  failures: Array<{ id: string; failures: string[] }>;
}

export interface ProviderCacheCanaryPacket {
  canary: ProviderCacheCanaryCase;
  sessionKey: string;
  first: OptimizedRequest;
  second: OptimizedRequest;
}

export interface ProviderCacheLiveEndpoint {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface ProviderCacheLiveCanaryOptions {
  enabled: boolean;
  costAck: boolean;
  allowedProviderIds: string[];
  endpoints: Record<string, ProviderCacheLiveEndpoint | undefined>;
  fetchImpl?: typeof fetch;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  requireCacheHit?: boolean;
}

export type ProviderCacheLiveCanaryStatus = "skipped" | "passed" | "failed";

export interface ProviderCacheLiveCanaryResult {
  id: string;
  displayName: string;
  status: ProviderCacheLiveCanaryStatus;
  reason?: string;
  failures: string[];
  warnings: string[];
  httpStatuses: number[];
  promptTokens: number;
  cachedPromptTokens: number;
  cacheCreationTokens: number;
  cacheHitPct: number;
  recommendation: TokenEconomicsDecision["recommendation"] | "not_run";
}

export interface ProviderCacheLiveCanarySummary {
  passed: boolean;
  total: number;
  skipped: number;
  failed: number;
  failures: Array<{ id: string; failures: string[] }>;
}

const LONG_STABLE_RULES = Array.from(
  { length: 720 },
  (_, idx) => `- Stable cache canary rule ${idx + 1}: preserve deterministic prompt ordering and tool schemas.`,
).join("\n");

const LONG_PROJECT_GUIDANCE = Array.from(
  { length: 220 },
  (_, idx) => `- Project convention ${idx + 1}: keep implementation scoped and verification explicit.`,
).join("\n");

export const PROVIDER_CACHE_CANARY_CASES: ProviderCacheCanaryCase[] = [
  {
    id: "anthropic",
    displayName: "Anthropic explicit ephemeral cache",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-latest",
    providerTag: "anthropic",
    endpointCapability: "none",
    markerBackend: "anthropic",
    expectedProviderStrategy: "explicit_ephemeral",
    expectedHintStrategy: "anthropic_explicit",
    requiresExplicitMarkers: true,
    premiumCache: false,
    minPrefixStableBytes: 8_000,
  },
  {
    id: "dashscope",
    displayName: "DashScope explicit premium cache",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    providerTag: "dashscope",
    endpointCapability: "dashscope",
    markerBackend: "dashscope",
    expectedProviderStrategy: "explicit_premium",
    requiresExplicitMarkers: true,
    premiumCache: true,
    minPrefixStableBytes: 8_000,
  },
  {
    id: "openai-compatible",
    displayName: "Generic OpenAI-compatible implicit cache",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    providerTag: "openai",
    endpointCapability: "none",
    markerBackend: "none",
    expectedProviderStrategy: "implicit_prefix",
    requiresExplicitMarkers: false,
    premiumCache: false,
    minPrefixStableBytes: 8_000,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter sticky implicit cache",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-coder",
    providerTag: "openrouter",
    endpointCapability: "none",
    markerBackend: "none",
    expectedProviderStrategy: "implicit_prefix",
    expectedHintStrategy: "openrouter_auto",
    requiresExplicitMarkers: false,
    premiumCache: false,
    minPrefixStableBytes: 8_000,
  },
  {
    id: "deepseek",
    displayName: "DeepSeek automatic prefix cache",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    providerTag: "deepseek",
    endpointCapability: "none",
    markerBackend: "none",
    expectedProviderStrategy: "implicit_prefix",
    expectedHintStrategy: "deepseek_auto",
    requiresExplicitMarkers: false,
    premiumCache: false,
    minPrefixStableBytes: 8_000,
  },
  {
    id: "vllm",
    displayName: "Self-hosted vLLM implicit KV cache",
    baseUrl: "http://localhost:8000/v1",
    model: "qwen3-coder",
    providerTag: "vllm",
    endpointCapability: "none",
    markerBackend: "none",
    expectedProviderStrategy: "implicit_prefix",
    expectedHintStrategy: "implicit_prefix",
    requiresExplicitMarkers: false,
    premiumCache: false,
    minPrefixStableBytes: 8_000,
  },
];

function canaryTools(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 file from the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run a deterministic test command.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];
}

function canaryMessages(turn: number): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are an AI coding assistant provided by Synesis.",
        "<SYNESIS_CODER_WORKFLOW>",
        LONG_STABLE_RULES,
        "</SYNESIS_CODER_WORKFLOW>",
      ].join("\n"),
    },
    {
      role: "system",
      content: ["# AGENTS.md", LONG_PROJECT_GUIDANCE].join("\n"),
    },
    {
      role: "assistant",
      content: "I will preserve the stable prefix and inspect only the changed tail.",
    },
    {
      role: "user",
      content: `Provider cache canary turn ${turn}: validate cache behavior without changing the stable instructions.`,
    },
    {
      role: "system",
      content: [
        "<user_info>",
        `Today's date: 2026-05-${20 + turn}`,
        `cwd: /tmp/provider-cache-canary-${turn}`,
        "</user_info>",
      ].join("\n"),
    },
  ];
}

export function buildProviderCacheCanaryPacket(canary: ProviderCacheCanaryCase): ProviderCacheCanaryPacket {
  const optimizer = new PrefixOptimizer({
    markerBackend: canary.markerBackend,
    maxMarkers: 3,
    enableDiagnosticLogging: false,
  });
  const sessionKey = `cache-canary-${canary.id}`;
  const first = optimizer.optimize(canaryMessages(1), canaryTools(), sessionKey, {
    markerBackend: canary.markerBackend,
  });
  const second = optimizer.optimize(canaryMessages(2), canaryTools(), sessionKey, {
    markerBackend: canary.markerBackend,
  });
  return { canary, sessionKey, first, second };
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, idx) => value === right[idx]);
}

function countDashScopeAnnotations(
  messages: Array<{ content?: unknown }>,
  tools: Array<{ cache_control?: unknown }> | undefined,
): { messageMarkers: number; toolMarkers: number } {
  let messageMarkers = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (message.content.some((block) => typeof block === "object" && block !== null && "cache_control" in block)) {
      messageMarkers += 1;
    }
  }
  const toolMarkers = Array.isArray(tools)
    ? tools.filter((tool) => typeof tool.cache_control === "object" && tool.cache_control !== null).length
    : 0;
  return { messageMarkers, toolMarkers };
}

function evaluateDashScopeAnnotations(
  canary: ProviderCacheCanaryCase,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  markerIndices: number[],
): { messageMarkers: number; toolMarkers: number } {
  if (canary.endpointCapability !== "dashscope") {
    return { messageMarkers: 0, toolMarkers: 0 };
  }

  const adapter = getEndpointTransportAdapter("dashscope", {
    dashscope: { mode: "auto", canaryPct: 0, maxMarkers: 3 },
  });
  const originalLog = console.log;
  let augmented: { input: RequestInfo | URL; init?: RequestInit };
  try {
    console.log = () => undefined;
    augmented = adapter.augmentRequest(
      canary.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: canary.model, messages, tools }),
      },
      () => `cache-canary-${canary.id}`,
      () => markerIndices,
    );
  } finally {
    console.log = originalLog;
  }

  if (!augmented.init?.body || typeof augmented.init.body !== "string") {
    return { messageMarkers: 0, toolMarkers: 0 };
  }
  const body = JSON.parse(augmented.init.body) as {
    messages?: Array<{ content?: unknown }>;
    tools?: Array<{ cache_control?: unknown }>;
  };
  return countDashScopeAnnotations(body.messages ?? [], body.tools);
}

function augmentDashScopeOpenAiBody(
  canary: ProviderCacheCanaryCase,
  body: Record<string, unknown>,
  markerIndices: number[],
): Record<string, unknown> {
  if (canary.endpointCapability !== "dashscope") {
    return body;
  }

  const adapter = getEndpointTransportAdapter("dashscope", {
    dashscope: { mode: "auto", canaryPct: 0, maxMarkers: 3 },
  });
  const originalLog = console.log;
  let augmented: { input: RequestInfo | URL; init?: RequestInit };
  try {
    console.log = () => undefined;
    augmented = adapter.augmentRequest(
      canary.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      () => `cache-canary-${canary.id}`,
      () => markerIndices,
    );
  } finally {
    console.log = originalLog;
  }

  if (!augmented.init?.body || typeof augmented.init.body !== "string") {
    return body;
  }
  return JSON.parse(augmented.init.body) as Record<string, unknown>;
}

export function buildProviderCacheOpenAiProbeBody(
  canary: ProviderCacheCanaryCase,
  optimized: OptimizedRequest,
  options?: { model?: string; maxCompletionTokens?: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options?.model ?? canary.model,
    messages: optimized.messages,
    temperature: 0,
    max_tokens: Math.max(1, options?.maxCompletionTokens ?? 32),
  };
  if (optimized.tools && optimized.tools.length > 0) {
    body.tools = optimized.tools;
    body.tool_choice = "none";
  }
  return augmentDashScopeOpenAiBody(canary, body, optimized.markerIndices);
}

function evaluateAnthropicAnnotations(canary: ProviderCacheCanaryCase, messages: ChatMessage[]): number {
  if (canary.markerBackend !== "anthropic") return 0;
  const annotated = annotateCacheBreakpoints(messages, "anthropic_explicit", { volatileTailSize: 2 });
  return annotated.stats.breakpointsPlaced;
}

function buildDecisions(canary: ProviderCacheCanaryCase, prefixStableBytes: number) {
  const hit = buildTokenEconomicsDecision({
    provider: canary.providerTag,
    tier: "cache-canary",
    model: canary.model,
    promptTokens: 8_000,
    completionTokens: 120,
    cachedTokens: 5_000,
    cacheCreationTokens: 0,
    prefixStableBytes,
  });
  const miss = buildTokenEconomicsDecision({
    provider: canary.providerTag,
    tier: "cache-canary",
    model: canary.model,
    promptTokens: 8_000,
    completionTokens: 120,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    prefixStableBytes,
    inputCharsOriginal: 36_000,
    inputCharsFinal: 28_000,
  });
  const writeWithoutRead = canary.premiumCache
    ? buildTokenEconomicsDecision({
        provider: canary.providerTag,
        tier: "cache-canary",
        model: canary.model,
        promptTokens: 8_000,
        completionTokens: 120,
        cachedTokens: 0,
        cacheCreationTokens: 4_000,
        prefixStableBytes,
      })
    : undefined;
  return { hit, miss, writeWithoutRead };
}

export function runProviderCacheCanary(canary: ProviderCacheCanaryCase): ProviderCacheCanaryResult {
  const failures: string[] = [];
  const { first, second } = buildProviderCacheCanaryPacket(canary);
  const markerStable = sameNumberArray(first.markerIndices, second.markerIndices);
  const prefixStableBytes = second.diagnostics.prefixStableBytes;
  const providerStrategy = inferProviderCacheStrategy(canary.providerTag);
  const cacheHintStrategy = detectCacheStrategy(canary.baseUrl, canary.model);
  const dashscopeAnnotations = evaluateDashScopeAnnotations(
    canary,
    second.messages,
    second.tools,
    second.markerIndices,
  );
  const anthropicBreakpoints = evaluateAnthropicAnnotations(canary, second.messages);
  const decisions = buildDecisions(canary, prefixStableBytes);

  if (providerStrategy !== canary.expectedProviderStrategy) {
    failures.push(`provider_strategy:${providerStrategy} expected:${canary.expectedProviderStrategy}`);
  }
  if (canary.expectedHintStrategy && cacheHintStrategy !== canary.expectedHintStrategy) {
    failures.push(`cache_hint_strategy:${cacheHintStrategy} expected:${canary.expectedHintStrategy}`);
  }
  if (prefixStableBytes < canary.minPrefixStableBytes) {
    failures.push(`prefix_stable_bytes:${prefixStableBytes} below:${canary.minPrefixStableBytes}`);
  }
  if (!markerStable) {
    failures.push(`marker_indices_changed:${first.markerIndices.join(",")} -> ${second.markerIndices.join(",")}`);
  }
  if (canary.requiresExplicitMarkers && second.markerIndices.length === 0) {
    failures.push("explicit_markers_missing");
  }
  if (!canary.requiresExplicitMarkers && second.markerIndices.length > 0) {
    failures.push(`unexpected_explicit_markers:${second.markerIndices.join(",")}`);
  }
  if (canary.markerBackend === "dashscope" && dashscopeAnnotations.messageMarkers === 0) {
    failures.push("dashscope_cache_control_missing");
  }
  if (canary.markerBackend === "dashscope" && dashscopeAnnotations.toolMarkers === 0) {
    failures.push("dashscope_tool_cache_control_missing");
  }
  if (canary.markerBackend === "anthropic" && anthropicBreakpoints === 0) {
    failures.push("anthropic_cache_control_missing");
  }
  if (decisions.hit.recommendation !== "cache_healthy" || decisions.hit.cacheOutcome !== "hit") {
    failures.push(`hit_decision_unhealthy:${decisions.hit.recommendation}/${decisions.hit.cacheOutcome}`);
  }
  if (decisions.miss.recommendation !== "preserve_stable_prefix_and_investigate") {
    failures.push(`miss_decision_not_cache_first:${decisions.miss.recommendation}`);
  }
  if (canary.premiumCache && decisions.writeWithoutRead?.recommendation !== "disable_premium_cache_write") {
    failures.push(`premium_write_without_read_not_suppressed:${decisions.writeWithoutRead?.recommendation ?? "none"}`);
  }

  return {
    id: canary.id,
    displayName: canary.displayName,
    passed: failures.length === 0,
    failures,
    markerBackend: canary.markerBackend,
    providerStrategy,
    cacheHintStrategy,
    prefixStableBytes,
    markerIndicesFirst: first.markerIndices,
    markerIndicesSecond: second.markerIndices,
    markerStable,
    annotations: {
      dashscopeMessageMarkers: dashscopeAnnotations.messageMarkers,
      dashscopeToolMarkers: dashscopeAnnotations.toolMarkers,
      anthropicBreakpoints,
    },
    decisions,
  };
}

export function runProviderCacheCanaries(
  canaries: ProviderCacheCanaryCase[] = PROVIDER_CACHE_CANARY_CASES,
): ProviderCacheCanaryResult[] {
  return canaries.map((canary) => runProviderCacheCanary(canary));
}

export function summarizeProviderCacheCanaries(results: ProviderCacheCanaryResult[]): ProviderCacheCanarySummary {
  const failures = results
    .filter((result) => !result.passed)
    .map((result) => ({ id: result.id, failures: result.failures }));
  return {
    passed: failures.length === 0,
    total: results.length,
    failed: failures.length,
    failures,
  };
}

function liveSkipped(canary: ProviderCacheCanaryCase, reason: string): ProviderCacheLiveCanaryResult {
  return {
    id: canary.id,
    displayName: canary.displayName,
    status: "skipped",
    reason,
    failures: [],
    warnings: [],
    httpStatuses: [],
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheCreationTokens: 0,
    cacheHitPct: 0,
    recommendation: "not_run",
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function responseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function postOpenAiProbe(
  fetchImpl: typeof fetch,
  endpoint: ProviderCacheLiveEndpoint,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cache_canary_timeout")), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...endpoint.headers,
    };
    if (endpoint.apiKey) {
      headers.authorization = `Bearer ${endpoint.apiKey}`;
    }
    const response = await fetchImpl(chatCompletionsUrl(endpoint.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, json: responseJson(text), text };
  } finally {
    clearTimeout(timer);
  }
}

async function runOneLiveCanary(
  canary: ProviderCacheCanaryCase,
  options: ProviderCacheLiveCanaryOptions,
): Promise<ProviderCacheLiveCanaryResult> {
  if (!options.enabled) return liveSkipped(canary, "live_disabled");
  if (!options.costAck) return liveSkipped(canary, "cost_ack_required");
  if (!options.allowedProviderIds.includes(canary.id)) return liveSkipped(canary, "provider_not_allowed");
  const endpoint = options.endpoints[canary.id];
  if (!endpoint?.baseUrl) return liveSkipped(canary, "endpoint_not_configured");

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  const maxCompletionTokens = Math.max(1, options.maxCompletionTokens ?? 32);
  const packet = buildProviderCacheCanaryPacket(canary);
  const firstBody = buildProviderCacheOpenAiProbeBody(canary, packet.first, {
    model: endpoint.model,
    maxCompletionTokens,
  });
  const secondBody = buildProviderCacheOpenAiProbeBody(canary, packet.second, {
    model: endpoint.model,
    maxCompletionTokens,
  });
  const failures: string[] = [];
  const warnings: string[] = [];

  try {
    const first = await postOpenAiProbe(fetchImpl, endpoint, firstBody, timeoutMs);
    const second = await postOpenAiProbe(fetchImpl, endpoint, secondBody, timeoutMs);
    if (first.status < 200 || first.status >= 300) failures.push(`first_http_status:${first.status}`);
    if (second.status < 200 || second.status >= 300) failures.push(`second_http_status:${second.status}`);

    const secondUsage = extractUsage(second.json.usage as never);
    const cacheCreationTokens = secondUsage.cache_creation_tokens ?? 0;
    const decision = buildTokenEconomicsDecision({
      provider: canary.providerTag,
      tier: "live-cache-canary",
      model: endpoint.model ?? canary.model,
      promptTokens: secondUsage.prompt_tokens,
      completionTokens: secondUsage.completion_tokens,
      cachedTokens: secondUsage.cached_prompt_tokens,
      cacheCreationTokens,
      prefixStableBytes: packet.second.diagnostics.prefixStableBytes,
    });

    if (secondUsage.prompt_tokens <= 0 && secondUsage.completion_tokens <= 0) {
      warnings.push("provider_usage_missing");
    }
    if (decision.cacheOutcome !== "hit") {
      warnings.push(`cache_hit_unverified:${decision.cacheOutcome}`);
    }
    if (options.requireCacheHit && decision.cacheOutcome !== "hit") {
      failures.push(`required_cache_hit_missing:${decision.cacheOutcome}`);
    }
    for (const warning of decision.warnings) warnings.push(warning);

    return {
      id: canary.id,
      displayName: canary.displayName,
      status: failures.length > 0 ? "failed" : "passed",
      failures,
      warnings: [...new Set(warnings)],
      httpStatuses: [first.status, second.status],
      promptTokens: secondUsage.prompt_tokens,
      cachedPromptTokens: secondUsage.cached_prompt_tokens,
      cacheCreationTokens,
      cacheHitPct: decision.cacheHitPct,
      recommendation: decision.recommendation,
    };
  } catch (error) {
    return {
      id: canary.id,
      displayName: canary.displayName,
      status: "failed",
      failures: [`request_error:${error instanceof Error ? error.message : String(error)}`],
      warnings,
      httpStatuses: [],
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheCreationTokens: 0,
      cacheHitPct: 0,
      recommendation: "not_run",
    };
  }
}

export async function runProviderCacheLiveCanaries(
  options: ProviderCacheLiveCanaryOptions,
  canaries: ProviderCacheCanaryCase[] = PROVIDER_CACHE_CANARY_CASES,
): Promise<ProviderCacheLiveCanaryResult[]> {
  const results: ProviderCacheLiveCanaryResult[] = [];
  for (const canary of canaries) {
    results.push(await runOneLiveCanary(canary, options));
  }
  return results;
}

export function summarizeProviderCacheLiveCanaries(
  results: ProviderCacheLiveCanaryResult[],
): ProviderCacheLiveCanarySummary {
  const failures = results
    .filter((result) => result.status === "failed")
    .map((result) => ({ id: result.id, failures: result.failures }));
  return {
    passed: failures.length === 0,
    total: results.length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: failures.length,
    failures,
  };
}
