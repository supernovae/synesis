/**
 * Provider cache hints and explicit-cache plumbing.
 *
 * **Documentation:** [docs/CACHING.md](../docs/CACHING.md) — pluggable “tiered” cache,
 * observability, and why some vendor integrations show no real hit rate.
 *
 * Strategies for prefix cache reuse across providers:
 *
 * 1. **OpenRouter auto**: Sticky routing to same inference endpoint per
 *    account/model/conversation. Works for Claude, DeepSeek, Qwen, Gemini, GPT.
 *    No annotations needed — just stable message prefix ordering.
 *
 * 2. **DeepSeek direct**: Automatic prefix caching (1024+ token prefix).
 *    No annotations needed; prefix stability is sufficient.
 *
 * 3. **Implicit prefix**: vLLM, RunPod, and other inference engines that
 *    benefit from stable prefix ordering via KV-cache reuse.
 *
 * 4. **DashScope explicit**: endpoint-scoped `cache_control` markers are
 *    available behind `SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE`.
 *
 * 5. **Anthropic explicit**: `cache_control: { type: "ephemeral" }` on
 *    system message parts. Not yet active since Yarn uses createOpenAI.
 */

import { resolveEndpointCapabilityId } from "../providers/endpoint-capabilities/resolve.js";
import {
  normalizeModelCapabilityPreset,
  type ModelCapabilityPresetId,
} from "../providers/model-architecture-profile.js";

export type CacheStrategy = "anthropic_explicit" | "openrouter_auto" | "deepseek_auto" | "implicit_prefix" | "none";

export function detectCacheStrategy(
  baseUrl: string,
  backendModel: string,
  modelCapabilityPreset?: ModelCapabilityPresetId | string | null,
): CacheStrategy {
  const url = baseUrl.toLowerCase();
  const model = backendModel.toLowerCase();
  const preset = normalizeModelCapabilityPreset(modelCapabilityPreset);

  if (resolveEndpointCapabilityId(baseUrl) === "fireworks") {
    return "implicit_prefix";
  }

  if (url.includes("openrouter.ai")) {
    // OpenRouter sticky routing supports implicit caching for these provider families
    if (model.includes("claude") || model.includes("anthropic")
      || model.includes("deepseek") || model.includes("qwen")
      || model.includes("gemini") || model.includes("openai")
      || model.includes("gpt-")) {
      return "openrouter_auto";
    }
  }

  if (preset === "deepseek_v3" || preset === "deepseek_v4") {
    return "deepseek_auto";
  }

  if (
    preset === "qwen_3"
    || preset === "qwen_3_coder"
    || preset === "kimi_k2"
    || preset === "glm_4_5"
    || preset === "minimax_m1"
    || preset === "minimax_m2"
    || preset === "xiaomi_mimo_2"
    || preset === "xiaomi_mimo_2_5"
  ) {
    return "implicit_prefix";
  }

  if (url.includes("anthropic") || model.includes("claude")) {
    return "anthropic_explicit";
  }

  if (model.includes("deepseek") && !url.includes("openrouter")) {
    return "deepseek_auto";
  }

  // vLLM (self-hosted with prefix caching + RAM) and similar benefit from stable
  // prefix ordering for KV cache (implicit_prefix). DashScope explicit markers
  // are handled in endpoint-capabilities so this diagnostic helper remains conservative.
  if (url.includes("vllm") || url.includes("localhost") || url.includes("runpod") || url.includes(".svc.cluster.local")) {
    return "implicit_prefix";
  }

  return "none";
}

export interface CacheHintStats {
  strategy: CacheStrategy;
  stablePrefixBytes: number;
  breakpointsPlaced: number;
}

interface MessageLike {
  role: string;
  content: unknown;
}

/**
 * Number of messages from the tail of the conversation considered "volatile"
 * (the recent keep-window).  Everything before this is the "stable" epoch
 * anchor that should be KV-cached.
 */
export const VOLATILE_TAIL_SIZE = 20;

/**
 * Minimum token estimate for the volatile tail before we spend a 3rd
 * breakpoint to cache the first half of it.
 */
const BP3_TAIL_TOKEN_THRESHOLD = 10_000;
const APPROX_TOKENS_PER_MSG = 250;

export interface AnnotateCacheBreakpointsOptions {
  /** Override the volatile tail size (default: VOLATILE_TAIL_SIZE). */
  volatileTailSize?: number;
}

/**
 * Place Anthropic `cache_control` breakpoints at deterministic positions:
 *
 *   **BP1** — End of the leading system-message prefix (static; system
 *   prompt + tool definitions).
 *
 *   **BP2** — End of the epoch-anchor (frozen history).  Computed as
 *   `messages.length - volatileTailSize - 1`.  Because new messages only
 *   append to the tail, the byte-prefix up to BP2 is identical turn-over-
 *   turn and only shifts when the epoch re-anchors.
 *
 *   **BP3** (optional) — Midpoint of the volatile tail when the tail is
 *   large (>10 k tokens estimated).  Provides partial reuse of the recent
 *   window across retries and regenerations.
 *
 * If the conversation is too short for BP2 (or BP2 would overlap BP1),
 * it is omitted.
 *
 * For non-explicit strategies, computes stable prefix bytes for diagnostics
 * without modifying messages.
 */
export function annotateCacheBreakpoints(
  messages: MessageLike[],
  strategy: CacheStrategy,
  options?: AnnotateCacheBreakpointsOptions,
): { messages: MessageLike[]; stats: CacheHintStats } {
  const stats: CacheHintStats = {
    strategy,
    stablePrefixBytes: 0,
    breakpointsPlaced: 0,
  };

  if (strategy === "none" || strategy === "openrouter_auto" || strategy === "deepseek_auto" || strategy === "implicit_prefix") {
    let prefixBytes = 0;
    for (const m of messages) {
      if (m.role !== "system") break;
      prefixBytes += typeof m.content === "string" ? m.content.length : 0;
    }
    stats.stablePrefixBytes = prefixBytes;
    return { messages, stats };
  }

  const out = [...messages];
  const tailSize = options?.volatileTailSize ?? VOLATILE_TAIL_SIZE;

  // ── Locate end of leading system-message prefix ──────────────────────
  let lastSystemIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "system") {
      lastSystemIdx = i;
      stats.stablePrefixBytes += typeof out[i].content === "string"
        ? (out[i].content as string).length : 0;
    } else if (lastSystemIdx >= 0) {
      break;
    }
  }

  if (strategy !== "anthropic_explicit") {
    return { messages: out, stats };
  }

  const placeMark = (idx: number): void => {
    out[idx] = {
      ...out[idx],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    } as MessageLike;
    stats.breakpointsPlaced += 1;
  };

  // ── BP1: End of system prefix ────────────────────────────────────────
  if (lastSystemIdx >= 0) {
    placeMark(lastSystemIdx);
  }

  // ── BP2: End of the epoch-frozen stable history ──────────────────────
  const bp2 = out.length - tailSize - 1;
  if (bp2 > lastSystemIdx && bp2 > 0 && bp2 < out.length) {
    placeMark(bp2);
  }

  // ── BP3: Midpoint of the volatile tail (optional) ────────────────────
  const tailStart = Math.max(bp2 + 1, lastSystemIdx + 1);
  const tailLength = out.length - tailStart;
  if (tailLength * APPROX_TOKENS_PER_MSG > BP3_TAIL_TOKEN_THRESHOLD) {
    const bp3 = tailStart + Math.floor(tailLength / 2);
    if (bp3 > bp2 && bp3 < out.length - 1) {
      placeMark(bp3);
    }
  }

  return { messages: out, stats };
}

/**
 * Compute a stable prefix hash for cache diagnostics.
 * Used in forensics to detect when prefix changes between requests.
 */
export function computePrefixFingerprint(messages: MessageLike[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") break;
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }
  const combined = parts.join("\n---\n");
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
  }
  return `pfx_${(hash >>> 0).toString(36)}`;
}
