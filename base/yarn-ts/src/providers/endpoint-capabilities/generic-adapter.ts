import type { EndpointCapabilityId, EndpointTransportAdapter } from "./types.js";

export function createGenericEndpointAdapter(
  id: EndpointCapabilityId,
  telemetryProviderTag: string,
): EndpointTransportAdapter {
  return {
    id,
    telemetryProviderTag,
    augmentRequest(input, init) {
      return { input, init };
    },
    async transformResponse(response) {
      return response;
    },
  };
}
