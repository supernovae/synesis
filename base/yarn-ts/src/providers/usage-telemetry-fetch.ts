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
    try {
      const body = JSON.parse(init.body);
      isStreaming = body?.stream === true;
      messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
    } catch { /* not JSON, pass through */ }

    const resp = await nativeFetch(input, init);

    if (!isStreaming || !resp.body) return resp;

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
            const cached = details?.cached_tokens ?? 0;
            const creation = details?.cache_creation_input_tokens ?? 0;
            const prompt = usage?.prompt_tokens ?? 0;
            const completion = usage?.completion_tokens ?? 0;

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
