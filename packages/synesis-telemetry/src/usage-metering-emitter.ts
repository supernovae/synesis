import type { LlmUsage, PricingRates } from "./types.js";

export interface UsageMeteringEmitterConfig {
  adminUrl: string;
  adminToken: string;
  timeoutMs?: number;
}

/** Fire-and-forget POST to admin /api/v1/planner/usage/metering (PII-minimal row). */
export function emitPlannerUsageMetering(
  payload: {
    request_id: string;
    user_id: string;
    org_id: string;
    tenant_id: string;
    conversation_id?: string;
    model: string;
    tokens: LlmUsage;
    estimated_cost_usd: number;
    actual_cost_usd: number;
    pricing_source: string;
    auth_method?: string;
    auth_key_id?: string;
    auth_key_name?: string;
    auth_key_prefix?: string;
    rates_snapshot?: PricingRates;
    latency_ms: number;
    has_error: boolean;
  },
  config: UsageMeteringEmitterConfig,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): void {
  if (!config.adminUrl) return;

  const url = `${config.adminUrl.replace(/\/$/, "")}/api/v1/planner/usage/metering`;
  const body = JSON.stringify({
    request_id: payload.request_id,
    user_id: payload.user_id,
    org_id: payload.org_id,
    tenant_id: payload.tenant_id,
    conversation_id: payload.conversation_id ?? "",
    model: payload.model,
    tokens_in: payload.tokens.prompt_tokens,
    tokens_out: payload.tokens.completion_tokens,
    tokens_cached: payload.tokens.cached_prompt_tokens ?? 0,
    tokens_cache_write: payload.tokens.cache_creation_tokens ?? 0,
    estimated_cost_usd: payload.estimated_cost_usd,
    actual_cost_usd: payload.actual_cost_usd,
    pricing_source: payload.pricing_source,
    auth_method: payload.auth_method ?? "",
    auth_key_id: payload.auth_key_id ?? "",
    auth_key_name: payload.auth_key_name ?? "",
    auth_key_prefix: payload.auth_key_prefix ?? "",
    rates_snapshot: payload.rates_snapshot,
    latency_ms: payload.latency_ms,
    has_error: payload.has_error,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.adminToken) {
    headers["x-synesis-service-token"] = config.adminToken;
    headers["authorization"] = `Bearer ${config.adminToken}`;
  }

  void fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
  })
    .then((resp) => {
      if (!resp.ok) {
        logger?.warn(
          `planner usage metering HTTP ${resp.status} for ${payload.request_id}: ${resp.statusText}`,
        );
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`planner usage metering failed: ${msg}`);
    });
}
