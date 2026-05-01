import type { EndpointTransportAdapter } from "./types.js";

export interface EndpointTransportRetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxJitterMs: number): number {
  if (maxJitterMs <= 0) return 0;
  return Math.floor(Math.random() * (maxJitterMs + 1));
}

function computeBackoffDelayMs(
  attempt: number,
  policy: EndpointTransportRetryPolicy,
): number {
  const exp = Math.max(0, attempt - 1);
  const raw = policy.baseDelayMs * (2 ** exp);
  return Math.min(policy.maxDelayMs, raw) + jitter(policy.jitterMs);
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /timed?\s*out|econnreset|econnrefused|enotfound|socket hang up|fetch failed|networkerror|aborterror/i.test(msg);
}

function isReplayableRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): boolean {
  if (typeof Request !== "undefined" && input instanceof Request) {
    // Request bodies can be one-shot streams; be conservative.
    return false;
  }
  const method = String(init?.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS", "DELETE", "POST"].includes(method)) {
    return false;
  }
  const body = init?.body as unknown;
  if (body == null) return true;
  if (typeof body === "string") return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
  return false;
}

/**
 * Inner fetch: augment request (affinity, etc.) then transform JSON responses (header usage merge).
 */
export function composeEndpointTransportFetch(
  nativeFetch: typeof globalThis.fetch,
  adapter: EndpointTransportAdapter,
  getSessionKey: () => string | null,
  options?: { retryPolicy?: EndpointTransportRetryPolicy; getMarkerIndices?: () => number[] },
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const retryPolicy: EndpointTransportRetryPolicy = options?.retryPolicy ?? {
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
      jitterMs: 125,
    };
    const replayable = isReplayableRequest(input, init);
    let attempt = 1;

    while (true) {
      const augmented = adapter.augmentRequest(input, init, getSessionKey, options?.getMarkerIndices);
      try {
        const response = await nativeFetch(augmented.input, augmented.init);
        const shouldRetry =
          retryPolicy.enabled
          && replayable
          && attempt < retryPolicy.maxAttempts
          && isRetryableStatus(response.status);

        if (!shouldRetry) {
          return adapter.transformResponse(response, augmented.init);
        }

        const retryAfterMs = parseRetryAfterMs(response.headers);
        const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, retryPolicy);
        try {
          await response.body?.cancel();
        } catch {
          // Best effort: ignore if body cannot be cancelled.
        }
        console.log(JSON.stringify({
          level: 30,
          msg: "upstream_retry_scheduled",
          provider: adapter.telemetryProviderTag,
          attempt,
          max_attempts: retryPolicy.maxAttempts,
          status: response.status,
          delay_ms: delayMs,
          reason: "retryable_status",
        }));
        await sleep(delayMs);
        attempt += 1;
      } catch (err) {
        const shouldRetry =
          retryPolicy.enabled
          && replayable
          && attempt < retryPolicy.maxAttempts
          && isRetryableError(err);
        if (!shouldRetry) {
          throw err;
        }
        const delayMs = computeBackoffDelayMs(attempt, retryPolicy);
        console.log(JSON.stringify({
          level: 30,
          msg: "upstream_retry_scheduled",
          provider: adapter.telemetryProviderTag,
          attempt,
          max_attempts: retryPolicy.maxAttempts,
          delay_ms: delayMs,
          reason: "retryable_error",
          error: err instanceof Error ? err.message : String(err),
        }));
        await sleep(delayMs);
        attempt += 1;
      }
    }
  };
}
