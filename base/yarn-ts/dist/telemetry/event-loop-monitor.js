/**
 * Event loop lag monitor — uses Node.js perf_hooks.monitorEventLoopDelay()
 * to track P50/P95/P99 event loop latency for production observability.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
const NS_TO_MS = 1_000_000;
let histogram = null;
export function startEventLoopMonitor(resolutionMs = 20) {
    if (histogram)
        return;
    histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    histogram.enable();
}
export function getEventLoopStats() {
    if (!histogram) {
        return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const stats = {
        p50Ms: Math.round((histogram.percentile(50) / NS_TO_MS) * 100) / 100,
        p95Ms: Math.round((histogram.percentile(95) / NS_TO_MS) * 100) / 100,
        p99Ms: Math.round((histogram.percentile(99) / NS_TO_MS) * 100) / 100,
        maxMs: Math.round((histogram.max / NS_TO_MS) * 100) / 100,
    };
    histogram.reset();
    return stats;
}
export function stopEventLoopMonitor() {
    if (histogram) {
        histogram.disable();
        histogram = null;
    }
}
