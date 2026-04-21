import type { EndpointTransportAdapter } from "./types.js";

const FW_CACHED_HDR = "fireworks-cached-prompt-tokens";
const FW_PROMPT_HDR = "fireworks-prompt-tokens";

function parseFireworksHeaderInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function requestIsStreaming(init: RequestInit | undefined): boolean {
  if (!init?.body || typeof init.body !== "string") return false;
  try {
    const body = JSON.parse(init.body) as { stream?: unknown };
    return body?.stream === true;
  } catch {
    return false;
  }
}

/**
 * Fireworks: session affinity for replica-local prefix cache; merge dedicated-deployment
 * cache counts from response headers into non-streaming JSON bodies when body omits them.
 *
 * @see https://docs.fireworks.ai/guides/prompt-caching
 */
export function createFireworksEndpointAdapter(): EndpointTransportAdapter {
  return {
    id: "fireworks",
    telemetryProviderTag: "fireworks",

    augmentRequest(input, init, getSessionKey) {
      const sessionKey = getSessionKey()?.trim();
      if (!sessionKey) {
        return { input, init };
      }
      const headers = new Headers(init?.headers ?? undefined);
      if (!headers.has("x-session-affinity")) {
        headers.set("x-session-affinity", sessionKey);
      }
      return {
        input,
        init: init ? { ...init, headers } : { headers },
      };
    },

    async transformResponse(response, init) {
      if (!response.ok || requestIsStreaming(init)) {
        return response;
      }
      const ct = response.headers.get("content-type") ?? "";
      if (!ct.toLowerCase().includes("json")) {
        return response;
      }
      const hdrCached = parseFireworksHeaderInt(response.headers, FW_CACHED_HDR);
      const hdrPrompt = parseFireworksHeaderInt(response.headers, FW_PROMPT_HDR);
      if (hdrCached === undefined && hdrPrompt === undefined) {
        return response;
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        return response;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const usage = (payload.usage ?? null) as Record<string, unknown> | null;
      if (!usage || typeof usage !== "object") {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
      const rawCached = Number(details.cached_tokens ?? usage.cached_tokens ?? 0);
      const bodyCached = Number.isFinite(rawCached) ? rawCached : 0;
      const rawPrompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      const bodyPrompt = Number.isFinite(rawPrompt) ? rawPrompt : 0;
      let changed = false;
      if (hdrCached !== undefined && hdrCached > bodyCached) {
        details.cached_tokens = hdrCached;
        usage.prompt_tokens_details = details;
        changed = true;
      }
      if (hdrPrompt !== undefined && hdrPrompt > 0 && (!Number.isFinite(bodyPrompt) || bodyPrompt === 0)) {
        usage.prompt_tokens = hdrPrompt;
        changed = true;
      }
      if (!changed) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      payload.usage = usage;
      const out = JSON.stringify(payload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(out, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
