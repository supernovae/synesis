import type { EndpointCapabilityId, EndpointTransportAdapter } from "./types.js";
import { createDashScopeEndpointAdapter, type DashScopeEndpointAdapterOptions } from "./dashscope.js";
import { createFireworksEndpointAdapter } from "./fireworks.js";
import { createGenericEndpointAdapter } from "./generic-adapter.js";
import { createKimiCodingEndpointAdapter } from "./kimi-coding.js";

const fireworks = createFireworksEndpointAdapter();
const kimiCoding = createKimiCodingEndpointAdapter();

const generic = createGenericEndpointAdapter("generic", "generic");
const openrouter = createGenericEndpointAdapter("openrouter", "openrouter");
const vllm = createGenericEndpointAdapter("vllm", "vllm");
const deepseek = createGenericEndpointAdapter("deepseek", "deepseek");
const dashscopeDefault = createDashScopeEndpointAdapter({ mode: "off", canaryPct: 0, maxMarkers: 3 });

const byId: Record<EndpointCapabilityId, EndpointTransportAdapter> = {
  generic,
  openrouter,
  vllm,
  fireworks,
  kimi_coding: kimiCoding,
  dashscope: dashscopeDefault,
  deepseek,
};

export function getEndpointTransportAdapter(
  id: EndpointCapabilityId,
  opts?: { dashscope?: DashScopeEndpointAdapterOptions },
): EndpointTransportAdapter {
  if (id === "dashscope" && opts?.dashscope) {
    return createDashScopeEndpointAdapter(opts.dashscope);
  }
  return byId[id] ?? generic;
}
