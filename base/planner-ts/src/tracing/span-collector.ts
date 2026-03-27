import type { TraceSpanRecord, TraceLLMCallRecord } from "@synesis/telemetry";

const NODE_DISPLAY_NAMES: Record<string, string> = {
  entry_pipeline: "Frame extraction & classification",
  planner: "LLM Planner",
  plan_gate: "Plan gate validation",
  router: "Evidence router",
  writer: "Writer compose",
  critic: "Critic evaluation",
  final_scrubber: "Final scrubber",
  respond: "Response assembly",
  background_critic: "Background Critic (async)",
};

interface ActiveSpan {
  node_name: string;
  intent: string;
  start_time: number;
}

export interface SpanEndOpts {
  tokens_used?: number;
  confidence?: number;
  outcome?: string;
  reasoning?: string;
  llm_calls?: TraceLLMCallRecord[];
  metadata?: Record<string, unknown>;
}

export class SpanCollector {
  private active = new Map<string, ActiveSpan>();
  private completed: TraceSpanRecord[] = [];

  startSpan(nodeName: string, intent?: string): void {
    this.active.set(nodeName, {
      node_name: nodeName,
      intent: intent ?? NODE_DISPLAY_NAMES[nodeName] ?? nodeName,
      start_time: Date.now() / 1000,
    });
  }

  endSpan(nodeName: string, opts: SpanEndOpts = {}): void {
    const span = this.active.get(nodeName);
    if (!span) return;
    this.active.delete(nodeName);

    const endTime = Date.now() / 1000;
    const latencyMs = Math.round((endTime - span.start_time) * 1000);

    this.completed.push({
      node_name: span.node_name,
      intent: span.intent,
      start_time: span.start_time,
      end_time: endTime,
      latency_ms: latencyMs,
      tokens_used: opts.tokens_used ?? 0,
      confidence: opts.confidence ?? 0,
      outcome: opts.outcome ?? "ok",
      reasoning: opts.reasoning,
      llm_calls: opts.llm_calls ?? [],
      metadata: opts.metadata,
    });
  }

  getSpans(): TraceSpanRecord[] {
    for (const [nodeName] of this.active) {
      this.endSpan(nodeName, { outcome: "interrupted" });
    }
    return [...this.completed];
  }

  getPhaseTimings(): Record<string, number> {
    const timings: Record<string, number> = {};
    for (const span of this.completed) {
      timings[span.node_name] = span.latency_ms;
    }
    return timings;
  }
}
