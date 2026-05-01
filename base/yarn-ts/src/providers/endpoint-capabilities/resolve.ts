import type { EndpointCapabilityId } from "./types.js";

/**
 * Resolve transport capability from tier base URL (single source of truth for host heuristics).
 */
export function resolveEndpointCapabilityId(baseUrl: string): EndpointCapabilityId {
  let parsed: URL | undefined;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = undefined;
  }
  const host = parsed?.hostname.toLowerCase() ?? baseUrl.toLowerCase();
  const path = parsed?.pathname.toLowerCase() ?? baseUrl.toLowerCase();
  if (host === "fireworks.ai" || host.endsWith(".fireworks.ai")) return "fireworks";
  if (
    host === "dashscope.aliyuncs.com"
    || host.endsWith(".dashscope.aliyuncs.com")
    || /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(host)
  ) return "dashscope";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if ((host === "kimi.com" || host.endsWith(".kimi.com")) && path.includes("/coding")) return "kimi_coding";
  if (
    host.includes("vllm")
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.includes("runpod")
    || host.endsWith(".svc.cluster.local")
  ) {
    return "vllm";
  }
  return "generic";
}
