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

import { extractUsage } from "@synesis/telemetry";
import {
  buildTokenEconomicsDecision,
  tokenEconomicsLogRecord,
} from "../telemetry/token-economics.js";
import {
  buildAndRememberCacheDebugTrace,
  buildCacheDebugRequestSnapshot,
  type CacheDebugTraceContext,
  type CacheDebugTraceMode,
} from "../telemetry/cache-debug-trace.js";

interface TelemetryOpts {
  provider: string;
  tier: string;
  model: string;
  cacheDebugTraceMode?: CacheDebugTraceMode;
  getCacheDebugTraceContext?: () => CacheDebugTraceContext;
}

interface RequestTelemetry {
  isStreaming: boolean;
  messageCount: number;
  prefixHashes?: string[];
  toolsHash?: string;
  cacheMarkerCount: number;
}

interface UsageTelemetry {
  prompt: number;
  completion: number;
  cached: number;
  creation: number;
}

function parseFireworksHeaderInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function hashObject(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0;
  for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0;
  return `${(h >>> 0).toString(16).padStart(8, "0")}:${s.length}`;
}

function countCacheMarkers(value: unknown): number {
  if (value == null) return 0;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countCacheMarkers(item), 0);
  }
  if (typeof value !== "object") return 0;
  const obj = value as Record<string, unknown>;
  const self = obj.cache_control && typeof obj.cache_control === "object" ? 1 : 0;
  return self + Object.values(obj).reduce<number>((sum, child) => sum + countCacheMarkers(child), 0);
}

function inspectRequestBody(bodyText: string): RequestTelemetry {
  const fallback: RequestTelemetry = {
    isStreaming: false,
    messageCount: 0,
    cacheMarkerCount: 0,
  };
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const prefixHashes = messages.slice(0, 5).map((m, i) => {
      const msg = m as Record<string, unknown>;
      const role = String(msg.role ?? "?").slice(0, 1);
      return `${i}:${role}:${hashObject(m)}`;
    });
    const toolsHash = tools.length > 0 ? `${tools.length}t:${hashObject(tools)}` : undefined;
    return {
      isStreaming: body.stream === true,
      messageCount: messages.length,
      prefixHashes: prefixHashes.length > 0 ? prefixHashes : undefined,
      toolsHash,
      cacheMarkerCount: countCacheMarkers(messages) + countCacheMarkers(tools),
    };
  } catch {
    return fallback;
  }
}

function usageFromPayload(payload: unknown, headers: Headers, provider: string): UsageTelemetry | null {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const usageRaw = raw.usage as Record<string, unknown> | undefined;
  if (!usageRaw || typeof usageRaw !== "object") return null;

  const normalized = extractUsage(usageRaw as never);
  let cached = Number(normalized.cached_prompt_tokens ?? 0);
  let prompt = Number(normalized.prompt_tokens ?? 0);
  const completion = Number(normalized.completion_tokens ?? 0);
  const creation = Number(normalized.cache_creation_tokens ?? 0);

  const hdrCached =
    provider === "fireworks"
      ? parseFireworksHeaderInt(headers, "fireworks-cached-prompt-tokens")
      : undefined;
  const hdrPrompt =
    provider === "fireworks"
      ? parseFireworksHeaderInt(headers, "fireworks-prompt-tokens")
      : undefined;

  if (hdrCached !== undefined && hdrCached > cached) {
    cached = hdrCached;
  }
  if (hdrPrompt !== undefined && hdrPrompt > 0 && (!Number.isFinite(prompt) || prompt === 0)) {
    prompt = hdrPrompt;
  }

  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
    cached: Number.isFinite(cached) ? cached : 0,
    creation: Number.isFinite(creation) ? creation : 0,
  };
}

function emitUsageTelemetry(
  opts: TelemetryOpts,
  request: RequestTelemetry,
  usage: UsageTelemetry,
  source: "stream" | "non_stream",
): void {
  const decision = buildTokenEconomicsDecision({
    provider: opts.provider,
    tier: opts.tier,
    model: opts.model,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    cachedTokens: usage.cached,
    cacheCreationTokens: usage.creation,
    messageCount: request.messageCount,
    cacheMarkerCount: request.cacheMarkerCount,
  });

  console.log(JSON.stringify({
    level: 20,
    msg: "llm_usage_telemetry",
    provider: opts.provider,
    tier: opts.tier,
    model: opts.model,
    source,
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    cached_tokens: usage.cached,
    cache_creation: usage.creation,
    cache_hit_pct: decision.cacheHitPct,
    message_count: request.messageCount,
    cache_marker_count: request.cacheMarkerCount,
    ...(request.prefixHashes ? { prefix_hashes: request.prefixHashes } : {}),
    ...(request.toolsHash ? { tools_hash: request.toolsHash } : {}),
    token_economics: tokenEconomicsLogRecord(decision),
  }));
}

function emitCacheDebugTrace(
  opts: TelemetryOpts,
  bodyText: string,
  usage: UsageTelemetry,
  source: "stream" | "non_stream",
): void {
  if (opts.cacheDebugTraceMode !== "hashed") return;
  const snapshot = buildCacheDebugRequestSnapshot(bodyText, opts.getCacheDebugTraceContext?.());
  if (!snapshot) return;
  const record = buildAndRememberCacheDebugTrace({
    provider: opts.provider,
    tier: opts.tier,
    model: opts.model,
    source,
    snapshot,
    usage,
  });
  console.log(JSON.stringify(record));
}

export function createUsageTelemetryFetch(
  nativeFetch: typeof globalThis.fetch,
  opts: TelemetryOpts,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== "string") {
      return nativeFetch(input, init);
    }

    const requestTelemetry = inspectRequestBody(init.body);
    const requestBodyText = init.body;

    const resp = await nativeFetch(input, init);

    if (!requestTelemetry.isStreaming) {
      const ct = resp.headers.get("content-type") ?? "";
      if (!ct.toLowerCase().includes("json")) return resp;
      let text: string;
      try {
        text = await resp.text();
      } catch {
        return resp;
      }
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        const usage = usageFromPayload(payload, resp.headers, opts.provider);
        if (usage) {
          emitUsageTelemetry(opts, requestTelemetry, usage, "non_stream");
          emitCacheDebugTrace(opts, requestBodyText, usage, "non_stream");
        } else {
          emitCacheDebugTrace(opts, requestBodyText, { prompt: 0, completion: 0, cached: 0, creation: 0 }, "non_stream");
        }
      } catch {
        // Preserve malformed JSON exactly as received.
      }
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }

    if (!resp.body) return resp;

    const [forSDK, forDiag] = resp.body.tee();

    (async () => {
      try {
        const reader = forDiag.getReader();
        const decoder = new TextDecoder();
        let lastUsage = "";

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
            const usage = usageFromPayload(parsed, resp.headers, opts.provider);
            if (usage) {
              emitUsageTelemetry(opts, requestTelemetry, usage, "stream");
              emitCacheDebugTrace(opts, requestBodyText, usage, "stream");
            } else {
              emitCacheDebugTrace(opts, requestBodyText, { prompt: 0, completion: 0, cached: 0, creation: 0 }, "stream");
            }
          } catch { /* ignore parse error */ }
        } else {
          emitCacheDebugTrace(opts, requestBodyText, { prompt: 0, completion: 0, cached: 0, creation: 0 }, "stream");
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
