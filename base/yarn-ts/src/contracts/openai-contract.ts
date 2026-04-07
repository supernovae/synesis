export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function buildOpenAIPath(baseUrl: string, endpointPath: string): string {
  const base = normalizeOpenAIBaseUrl(baseUrl);
  const ep = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const finalPath = ep.startsWith("/v1/") ? ep : `/v1${ep}`;
  return `${base}${finalPath}`;
}

export function classifyOpenAIErrorStatus(status: number): "retryable" | "fatal" {
  if (status === 408 || status === 429) return "retryable";
  if (status >= 500 && status <= 599) return "retryable";
  return "fatal";
}
