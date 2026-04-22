import type { EndpointCapabilityId } from "./types.js";

/**
 * Resolve transport capability from tier base URL (single source of truth for host heuristics).
 */
export function resolveEndpointCapabilityId(baseUrl: string): EndpointCapabilityId {
  const u = baseUrl.toLowerCase();
  if (u.includes("fireworks.ai")) return "fireworks";
  if (u.includes("openrouter.ai")) return "openrouter";
  if (u.includes("kimi.com") && u.includes("/coding")) return "kimi_coding";
  if (
    u.includes("vllm")
    || u.includes("localhost")
    || u.includes("runpod")
    || u.includes(".svc.cluster.local")
  ) {
    return "vllm";
  }
  return "generic";
}
