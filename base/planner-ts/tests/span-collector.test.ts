import { describe, expect, it } from "vitest";
import { SpanCollector } from "../src/tracing/span-collector.js";

describe("SpanCollector", () => {
  it("records spans with timing", async () => {
    const collector = new SpanCollector();
    collector.startSpan("entry_pipeline");
    await new Promise((r) => setTimeout(r, 10));
    collector.endSpan("entry_pipeline", {
      outcome: "classified",
      confidence: 0.5,
      metadata: { difficulty: 0.3 },
    });

    const spans = collector.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].node_name).toBe("entry_pipeline");
    expect(spans[0].intent).toBe("Frame extraction & classification");
    expect(spans[0].latency_ms).toBeGreaterThanOrEqual(5);
    expect(spans[0].outcome).toBe("classified");
    expect(spans[0].confidence).toBe(0.5);
    expect(spans[0].metadata).toEqual({ difficulty: 0.3 });
    expect(spans[0].start_time).toBeLessThan(spans[0].end_time);
  });

  it("records multiple spans in order", () => {
    const collector = new SpanCollector();
    collector.startSpan("entry_pipeline");
    collector.endSpan("entry_pipeline", { outcome: "ok" });
    collector.startSpan("planner");
    collector.endSpan("planner", { outcome: "plan_generated", confidence: 0.8 });
    collector.startSpan("router");
    collector.endSpan("router", { outcome: "skip" });

    const spans = collector.getSpans();
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.node_name)).toEqual(["entry_pipeline", "planner", "router"]);
  });

  it("attaches llm_calls to spans", () => {
    const collector = new SpanCollector();
    collector.startSpan("writer");
    collector.endSpan("writer", {
      outcome: "draft_composed",
      tokens_used: 500,
      llm_calls: [{
        model: "gpt-4",
        node: "writer",
        prompt_tokens: 300,
        completion_tokens: 200,
        total_tokens: 500,
        latency_ms: 1200,
        timestamp: Date.now() / 1000,
      }],
    });

    const spans = collector.getSpans();
    expect(spans[0].tokens_used).toBe(500);
    expect(spans[0].llm_calls).toHaveLength(1);
    expect(spans[0].llm_calls[0].model).toBe("gpt-4");
  });

  it("auto-closes active spans on getSpans()", () => {
    const collector = new SpanCollector();
    collector.startSpan("entry_pipeline");

    const spans = collector.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].outcome).toBe("interrupted");
  });

  it("silently ignores endSpan for unknown node", () => {
    const collector = new SpanCollector();
    collector.endSpan("nonexistent", { outcome: "ok" });
    expect(collector.getSpans()).toHaveLength(0);
  });

  it("produces phase timings from completed spans", () => {
    const collector = new SpanCollector();
    collector.startSpan("entry_pipeline");
    collector.endSpan("entry_pipeline", { outcome: "ok" });
    collector.startSpan("writer");
    collector.endSpan("writer", { outcome: "ok" });

    const timings = collector.getPhaseTimings();
    expect(timings).toHaveProperty("entry_pipeline");
    expect(timings).toHaveProperty("writer");
    expect(typeof timings.entry_pipeline).toBe("number");
  });

  it("uses display name as default intent", () => {
    const collector = new SpanCollector();
    collector.startSpan("critic");
    collector.endSpan("critic", { outcome: "approved" });

    const spans = collector.getSpans();
    expect(spans[0].intent).toBe("Critic evaluation");
  });

  it("allows custom intent override", () => {
    const collector = new SpanCollector();
    collector.startSpan("writer", "Custom Writer Intent");
    collector.endSpan("writer", { outcome: "ok" });

    const spans = collector.getSpans();
    expect(spans[0].intent).toBe("Custom Writer Intent");
  });
});
