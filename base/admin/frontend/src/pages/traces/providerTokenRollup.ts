/** Provider-reported prompt token breakdown (cache read / cache write) for trace list + detail. */

export type ProviderTokenRollup = {
  prompt: number;
  cached: number;
  cacheWrite: number;
  completion: number;
  /** Percent of prompt_tokens that were cache hits (0–100), or null if prompt is 0. */
  hitPct: number | null;
};

export type ProviderTokenRollupInput = {
  tokens?: unknown;
  total_prompt_tokens_reported?: number | null;
  total_cached_prompt_tokens?: number;
  total_cache_creation_tokens?: number;
  total_completion_tokens_reported?: number;
  prompt_cache_hit_ratio?: number | null;
};

export function getProviderTokenRollup(
  trace: ProviderTokenRollupInput,
): ProviderTokenRollup | null {
  if (trace.total_prompt_tokens_reported != null) {
    const prompt = Number(trace.total_prompt_tokens_reported) || 0;
    const cached = Number(trace.total_cached_prompt_tokens ?? 0) || 0;
    const cacheWrite = Number(trace.total_cache_creation_tokens ?? 0) || 0;
    const completion = Number(trace.total_completion_tokens_reported ?? 0) || 0;
    let hitPct: number | null = null;
    if (trace.prompt_cache_hit_ratio != null) {
      hitPct = Math.round(Number(trace.prompt_cache_hit_ratio) * 1000) / 10;
    } else if (prompt > 0) {
      hitPct = Math.round((cached / prompt) * 1000) / 10;
    }
    return { prompt, cached, cacheWrite, completion, hitPct };
  }
  const tok = trace.tokens;
  if (tok && typeof tok === "object" && !Array.isArray(tok)) {
    const o = tok as Record<string, unknown>;
    const prompt = Number(o.prompt_tokens ?? 0) || 0;
    const cached = Number(o.cached_prompt_tokens ?? 0) || 0;
    const cacheWrite = Number(o.cache_creation_tokens ?? 0) || 0;
    const completion = Number(o.completion_tokens ?? 0) || 0;
    const hitPct = prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : null;
    return { prompt, cached, cacheWrite, completion, hitPct };
  }
  return null;
}

export function formatProviderCacheSummary(r: ProviderTokenRollup): string {
  const hit =
    r.hitPct != null ? `${r.hitPct}% hit` : "— hit";
  return `${hit} · read ${r.cached.toLocaleString()} · write ${r.cacheWrite.toLocaleString()}`;
}
