import { Counter, Gauge, Histogram } from "prom-client";
export function createServiceMetrics(service, registry) {
    return {
        requestTotal: new Counter({
            name: `synesis_${service}_request_total`,
            help: `Total requests handled by ${service}`,
            registers: [registry],
            labelNames: ["status", "model", "tier"],
        }),
        tokenTotal: new Counter({
            name: `synesis_${service}_token_total`,
            help: `Total tokens processed by ${service}`,
            registers: [registry],
            labelNames: ["direction", "cache_status", "model"],
        }),
        costEstimatedTotal: new Counter({
            name: `synesis_${service}_cost_estimated_usd_total`,
            help: `Total estimated cost in USD for ${service}`,
            registers: [registry],
            labelNames: ["model"],
        }),
        costActualTotal: new Counter({
            name: `synesis_${service}_cost_actual_usd_total`,
            help: `Total actual (provider-reported) cost in USD for ${service}`,
            registers: [registry],
            labelNames: ["model"],
        }),
        cacheHitRatio: new Gauge({
            name: `synesis_${service}_cache_hit_ratio`,
            help: `Rolling prefix cache hit ratio for ${service}`,
            registers: [registry],
            labelNames: ["model"],
        }),
        requestDuration: new Histogram({
            name: `synesis_${service}_request_duration_seconds`,
            help: `Request duration in seconds for ${service}`,
            registers: [registry],
            labelNames: ["model"],
            buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
        }),
        compactionTotal: new Counter({
            name: `synesis_${service}_compaction_total`,
            help: `Total compaction events for ${service}`,
            registers: [registry],
            labelNames: ["type"],
        }),
        compactionCharsSaved: new Counter({
            name: `synesis_${service}_compaction_chars_saved_total`,
            help: `Total characters saved by compaction for ${service}`,
            registers: [registry],
        }),
        sessionCheckpointTotal: new Counter({
            name: `synesis_${service}_session_checkpoint_total`,
            help: `Total session checkpoints for ${service}`,
            registers: [registry],
        }),
    };
}
/**
 * Record usage metrics from an LlmUsage result.
 */
export function recordUsageMetrics(metrics, model, tier, usage, latencySeconds, status = "ok") {
    metrics.requestTotal.inc({ status, model, tier });
    metrics.requestDuration.observe({ model }, latencySeconds);
    const uncached = Math.max(0, usage.prompt_tokens - usage.cached_prompt_tokens);
    metrics.tokenTotal.inc({ direction: "in", cache_status: "uncached", model }, uncached);
    metrics.tokenTotal.inc({ direction: "in", cache_status: "cached", model }, usage.cached_prompt_tokens);
    metrics.tokenTotal.inc({ direction: "out", cache_status: "uncached", model }, usage.completion_tokens);
    if (usage.estimated_cost_usd > 0) {
        metrics.costEstimatedTotal.inc({ model }, usage.estimated_cost_usd);
    }
    if (usage.actual_cost_usd > 0) {
        metrics.costActualTotal.inc({ model }, usage.actual_cost_usd);
    }
    if (usage.prompt_tokens > 0) {
        metrics.cacheHitRatio.set({ model }, usage.cached_prompt_tokens / usage.prompt_tokens);
    }
}
//# sourceMappingURL=metrics.js.map