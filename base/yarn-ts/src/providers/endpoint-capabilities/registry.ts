import type { EndpointCapabilityId, EndpointTransportAdapter } from "./types.js";
import { createFireworksEndpointAdapter } from "./fireworks.js";
import { createGenericEndpointAdapter } from "./generic-adapter.js";

const fireworks = createFireworksEndpointAdapter();

const generic = createGenericEndpointAdapter("generic", "generic");
const openrouter = createGenericEndpointAdapter("openrouter", "openrouter");
const vllm = createGenericEndpointAdapter("vllm", "vllm");

const byId: Record<EndpointCapabilityId, EndpointTransportAdapter> = {
  generic,
  openrouter,
  vllm,
  fireworks,
};

export function getEndpointTransportAdapter(id: EndpointCapabilityId): EndpointTransportAdapter {
  return byId[id] ?? generic;
}
