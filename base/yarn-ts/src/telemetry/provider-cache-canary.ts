import { annotateCacheBreakpoints, detectCacheStrategy, type CacheStrategy } from "../context/provider-cache-hints.js";
import { getEndpointTransportAdapter } from "../providers/endpoint-capabilities/registry.js";
import type { EndpointCapabilityId } from "../providers/endpoint-capabilities/types.js";
import { PrefixOptimizer } from "../providers/prefix-optimizer/index.js";
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
