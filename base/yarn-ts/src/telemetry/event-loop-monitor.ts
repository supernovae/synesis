/**
 * Event loop lag monitor — uses Node.js perf_hooks.monitorEventLoopDelay()
 * to track P50/P95/P99 event loop latency for production observability.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface EventLoopStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const NS_TO_MS = 1_000_000;

let histogram: IntervalHistogram | null = null;

export function startEventLoopMonitor(resolutionMs = 20): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
}

export function getEventLoopStats(): EventLoopStats {
  if (!histogram) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const stats: EventLoopStats = {
    p50Ms: Math.round((histogram.percentile(50) / NS_TO_MS) * 100) / 100,
    p95Ms: Math.round((histogram.percentile(95) / NS_TO_MS) * 100) / 100,
    p99Ms: Math.round((histogram.percentile(99) / NS_TO_MS) * 100) / 100,
    maxMs: Math.round((histogram.max / NS_TO_MS) * 100) / 100,
  };
  histogram.reset();
  return stats;
}

export function stopEventLoopMonitor(): void {
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}
