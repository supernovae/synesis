import type { EndpointTransportAdapter } from "./types.js";

/** Use Synesis' own identity. Deployment overrides must identify an approved client. */
const DEFAULT_KIMI_CODING_UA = "synesis-yarn/0.1.0";

function kimiCodingUserAgent(): string {
  const fromEnv = (process.env.SYNESIS_YARN_KIMI_CODING_USER_AGENT ?? "").trim();
  return fromEnv || DEFAULT_KIMI_CODING_UA;
}

function mergeHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
  const h = new Headers();
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => h.set(k, v));
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) h.set(k, v);
    } else {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        if (v != null) h.set(k, String(v));
      }
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    h.set(k, v);
  }
  return { ...init, headers: h };
}

export function createKimiCodingEndpointAdapter(): EndpointTransportAdapter {
  return {
    id: "kimi_coding",
    telemetryProviderTag: "kimi_coding",
    augmentRequest(input, init) {
      const ua = kimiCodingUserAgent();
      return {
        input,
        init: mergeHeaders(init, { "user-agent": ua }),
      };
    },
    async transformResponse(response) {
      return response;
    },
  };
}
