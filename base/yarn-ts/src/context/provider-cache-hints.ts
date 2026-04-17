/**
 * Provider Cache Hints
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
 * 3. **Implicit prefix**: vLLM, RunPod, DashScope, and other inference
 *    engines that benefit from stable prefix ordering via KV-cache reuse.
 *    No explicit markers (DashScope explicit caching was tested and found to
 *    use full-body matching, not prefix matching — see alibaba-ticket).
 *
 * 4. **Anthropic explicit**: `cache_control: { type: "ephemeral" }` on
 *    system message parts. Not yet active since Yarn uses createOpenAI.
 */

export type CacheStrategy = "anthropic_explicit" | "openrouter_auto" | "deepseek_auto" | "implicit_prefix" | "none";

export function detectCacheStrategy(baseUrl: string, backendModel: string): CacheStrategy {
  const url = baseUrl.toLowerCase();
  const model = backendModel.toLowerCase();

  if (url.includes("openrouter.ai")) {
    // OpenRouter sticky routing supports implicit caching for these provider families
    if (model.includes("claude") || model.includes("anthropic")
      || model.includes("deepseek") || model.includes("qwen")
      || model.includes("gemini") || model.includes("openai")
      || model.includes("gpt-")) {
      return "openrouter_auto";
    }
  }

  if (url.includes("anthropic") || model.includes("claude")) {
    return "anthropic_explicit";
  }

  if (model.includes("deepseek") && !url.includes("openrouter")) {
    return "deepseek_auto";
  }

  // vLLM (self-hosted with prefix caching + RAM) and similar benefit from stable
  // prefix ordering for KV cache (implicit_prefix). DashScope explicit path removed
  // entirely to avoid fixed-marker capping of cached_tokens (now variable/high on long runs).
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
