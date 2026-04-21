/**
 * Lightweight fetch wrapper that captures usage telemetry from LLM API responses.
 *
 * Extracts cached_tokens, prompt_tokens, and completion_tokens from streaming
 * SSE responses for any OpenAI-compatible provider (OpenRouter, vLLM, DashScope, etc.).
 *
 * Does NOT inject cache_control markers or modify request bodies.
 * Prefix caching is handled implicitly by the inference engine based on
 * message ordering (which the PrefixOptimizer controls upstream).
 */

interface TelemetryOpts {
  provider: string;
  tier: string;
  model: string;
}

function parseFireworksHeaderInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function createUsageTelemetryFetch(
  nativeFetch: typeof globalThis.fetch,
  opts: TelemetryOpts,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== "string") {
      return nativeFetch(input, init);
    }

    let isStreaming = false;
    let messageCount = 0;
    let prefixHashes: string[] | undefined;
    let toolsHash: string | undefined;
    try {
      const body = JSON.parse(init.body);
      isStreaming = body?.stream === true;
      messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
      // Hash first 5 messages + tools to diagnose prefix cache breaks
      if (Array.isArray(body?.messages)) {
        prefixHashes = body.messages.slice(0, 5).map((m: Record<string, unknown>, i: number) => {
          const s = JSON.stringify(m);
          let h = 0;
          for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0;
          return `${i}:${String(m.role ?? "?").slice(0, 1)}:${(h >>> 0).toString(16).padStart(8, "0")}:${s.length}`;
        });
      }
      if (Array.isArray(body?.tools)) {
        const ts = JSON.stringify(body.tools);
        let h = 0;
        for (let j = 0; j < ts.length; j++) h = ((h << 5) - h + ts.charCodeAt(j)) | 0;
        toolsHash = `${body.tools.length}t:${(h >>> 0).toString(16).padStart(8, "0")}:${ts.length}`;
      }
    } catch { /* not JSON, pass through */ }

    const resp = await nativeFetch(input, init);

    if (!isStreaming || !resp.body) return resp;

    const hdrCached =
      opts.provider === "fireworks"
        ? parseFireworksHeaderInt(resp.headers, "fireworks-cached-prompt-tokens")
        : undefined;
    const hdrPrompt =
      opts.provider === "fireworks"
        ? parseFireworksHeaderInt(resp.headers, "fireworks-prompt-tokens")
        : undefined;

    const [forSDK, forDiag] = resp.body.tee();

    (async () => {
      try {
        const reader = forDiag.getReader();
        const decoder = new TextDecoder();
        let lastUsage = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ") && line.includes('"usage"') && !line.includes('"usage":null')) {
              lastUsage = line.slice(6);
            }
          }
        }
        if (lastUsage) {
          try {
            const parsed = JSON.parse(lastUsage);
            const usage = parsed?.usage;
            const details = usage?.prompt_tokens_details;
            let cached = Number(details?.cached_tokens ?? 0);
            let prompt = Number(usage?.prompt_tokens ?? 0);
            const creation = Number(
              details?.cache_creation_input_tokens ?? usage?.cache_creation_tokens ?? 0,
            );
            const completion = usage?.completion_tokens ?? 0;
            if (hdrCached !== undefined && hdrCached > cached) {
              cached = hdrCached;
            }
            if (hdrPrompt !== undefined && hdrPrompt > 0 && (!Number.isFinite(prompt) || prompt === 0)) {
              prompt = hdrPrompt;
            }

            console.log(JSON.stringify({
              level: 20,
              msg: "llm_usage_telemetry",
              provider: opts.provider,
              tier: opts.tier,
              model: opts.model,
              prompt_tokens: prompt,
              completion_tokens: completion,
              cached_tokens: cached,
              cache_creation: creation,
              cache_hit_pct: prompt > 0 ? Math.round((cached / prompt) * 100) : 0,
              message_count: messageCount,
              ...(hdrCached !== undefined ? { fireworks_header_cached_tokens: hdrCached } : {}),
              ...(prefixHashes ? { prefix_hashes: prefixHashes } : {}),
              ...(toolsHash ? { tools_hash: toolsHash } : {}),
            }));
          } catch { /* ignore parse error */ }
        }
      } catch { /* ignore stream read error */ }
    })();

    return new Response(forSDK, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  };
}
