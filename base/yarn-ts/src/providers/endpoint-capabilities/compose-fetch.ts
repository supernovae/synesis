import type { EndpointTransportAdapter } from "./types.js";

/**
 * Inner fetch: augment request (affinity, etc.) then transform JSON responses (header usage merge).
 */
export function composeEndpointTransportFetch(
  nativeFetch: typeof globalThis.fetch,
  adapter: EndpointTransportAdapter,
  getSessionKey: () => string | null,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const augmented = adapter.augmentRequest(input, init, getSessionKey);
    const response = await nativeFetch(augmented.input, augmented.init);
    return adapter.transformResponse(response, augmented.init);
  };
}
