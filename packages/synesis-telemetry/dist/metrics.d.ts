import { Registry, Counter, Gauge, Histogram } from "prom-client";
export interface ServiceMetrics {
    requestTotal: Counter;
    tokenTotal: Counter;
    costEstimatedTotal: Counter;
    costActualTotal: Counter;
    cacheHitRatio: Gauge;
    requestDuration: Histogram;
    compactionTotal: Counter;
    compactionCharsSaved: Counter;
    sessionCheckpointTotal: Counter;
}
export declare function createServiceMetrics(service: "planner" | "yarn", registry: Registry): ServiceMetrics;
/**
 * Record usage metrics from an LlmUsage result.
 */
export declare function recordUsageMetrics(metrics: ServiceMetrics, model: string, tier: string, usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_prompt_tokens: number;
    estimated_cost_usd: number;
    actual_cost_usd: number;
}, latencySeconds: number, status?: "ok" | "error"): void;
//# sourceMappingURL=metrics.d.ts.map