/**
 * Provider Cache Hints
 *
 * Annotates messages with cache control markers for providers that support
 * explicit prompt caching. Currently, two strategies:
 *
 * 1. **Anthropic (via @ai-sdk/anthropic)**: `cache_control: { type: "ephemeral" }`
 *    on system message parts. Not yet active since Yarn uses createOpenAI.
 *
 * 2. **OpenRouter**: Automatic prefix caching for supported models (Claude, DeepSeek).
 *    No annotations needed — just stable prefixes, which enrichWithFrameAndManifest
 *    + appendCriticBlock now provide (critic is a separate system message).
 *
 * 3. **DeepSeek**: Automatic prefix caching (first 1024+ tokens cached at provider).
 *    No annotation needed; prefix stability is sufficient.
 *
 * 4. **MiniMax**: No documented prompt caching API. Prefix stability may help
 *    via implicit KV-cache reuse on their side.
 *
 * This module provides:
 * - Detection of provider caching capability from the baseUrl / model name
 * - A message annotator for future Anthropic SDK integration
 * - Cache hit tracking helpers for forensics
 */

export type CacheStrategy = "anthropic_explicit" | "openrouter_auto" | "deepseek_auto" | "none";

export function detectCacheStrategy(baseUrl: string, backendModel: string): CacheStrategy {
  const url = baseUrl.toLowerCase();
  const model = backendModel.toLowerCase();

  if (url.includes("openrouter.ai")) {
    if (model.includes("claude") || model.includes("anthropic") || model.includes("deepseek")) {
      return "openrouter_auto";
    }
  }

  if (url.includes("anthropic") || model.includes("claude")) {
    return "anthropic_explicit";
  }

  if (model.includes("deepseek") && !url.includes("openrouter")) {
    return "deepseek_auto";
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
 * For Anthropic-explicit caching: annotate the last system message with
 * a cache_control breakpoint. The Vercel AI SDK Anthropic provider reads
 * `providerOptions.anthropic.cacheControl` on message parts.
 *
 * Currently a no-op for OpenAI SDK routes. Will activate when/if we add
 * direct Anthropic provider support.
 */
export function annotateCacheBreakpoints(
  messages: MessageLike[],
  strategy: CacheStrategy,
): { messages: MessageLike[]; stats: CacheHintStats } {
  const stats: CacheHintStats = {
    strategy,
    stablePrefixBytes: 0,
    breakpointsPlaced: 0,
  };

  if (strategy === "none" || strategy === "openrouter_auto" || strategy === "deepseek_auto") {
    let prefixBytes = 0;
    for (const m of messages) {
      if (m.role !== "system") break;
      prefixBytes += typeof m.content === "string" ? m.content.length : 0;
    }
    stats.stablePrefixBytes = prefixBytes;
    return { messages, stats };
  }

  const out = [...messages];
  let lastSystemIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "system") {
      lastSystemIdx = i;
      stats.stablePrefixBytes += typeof out[i].content === "string"
        ? (out[i].content as string).length : 0;
    } else if (out[i].role !== "system" && lastSystemIdx >= 0) {
      break;
    }
  }

  if (lastSystemIdx >= 0 && strategy === "anthropic_explicit") {
    const msg = out[lastSystemIdx];
    if (typeof msg.content === "string") {
      out[lastSystemIdx] = {
        ...msg,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      } as MessageLike;
      stats.breakpointsPlaced = 1;
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
