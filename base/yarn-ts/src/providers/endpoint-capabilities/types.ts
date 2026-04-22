/**
 * Endpoint-scoped transport hooks: vendor-specific request/response handling
 * resolved per tier (baseUrl), not applied globally across Yarn.
 */

export type EndpointCapabilityId = "generic" | "openrouter" | "vllm" | "fireworks" | "kimi_coding";

export interface EndpointTransportAdapter {
  readonly id: EndpointCapabilityId;
  /** Tag for llm_usage_telemetry and diagnostics (matches prior provider strings). */
  readonly telemetryProviderTag: string;
  augmentRequest(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    getSessionKey: () => string | null,
  ): { input: RequestInfo | URL; init?: RequestInit };
  /**
   * Optional response rewrite (e.g. merge Fireworks cache counts from headers into JSON body).
   * Must not consume the original body if returning the same Response unchanged.
   */
  transformResponse(response: Response, init: RequestInit | undefined): Promise<Response>;
}
