import type { EndpointCapabilityId, EndpointTransportAdapter } from "./types.js";
import { createFireworksEndpointAdapter } from "./fireworks.js";
import { createGenericEndpointAdapter } from "./generic-adapter.js";
import { createKimiCodingEndpointAdapter } from "./kimi-coding.js";

const fireworks = createFireworksEndpointAdapter();
const kimiCoding = createKimiCodingEndpointAdapter();

const generic = createGenericEndpointAdapter("generic", "generic");
const openrouter = createGenericEndpointAdapter("openrouter", "openrouter");
const vllm = createGenericEndpointAdapter("vllm", "vllm");

const byId: Record<EndpointCapabilityId, EndpointTransportAdapter> = {
  generic,
  openrouter,
  vllm,
  fireworks,
  kimi_coding: kimiCoding,
};

export function getEndpointTransportAdapter(id: EndpointCapabilityId): EndpointTransportAdapter {
  return byId[id] ?? generic;
}
