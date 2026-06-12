import { describe, expect, it } from "vitest";
import { sanitizeTraceForIngest, type TraceRecord } from "@synesis/telemetry";

function baseTrace(): TraceRecord {
  return {
    service: "planner",
    trace_id: "trace-1",
    request_id: "request-1",
    timestamp: 1,
    user_id: "user-1",
    org_id: "org-1",
    tenant_id: "tenant-1",
    model: "synesis-auto",
    tokens: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_prompt_tokens: 0,
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
    },
    cost: {
      estimated_usd: 0,
      actual_usd: 0,
      rates_snapshot: {
        input_per_million: 0,
        output_per_million: 0,
        cached_input_per_million: null,
      },
    },
    latency_ms: 0,
  };
}

describe("sanitizeTraceForIngest", () => {
  it("normalizes critic-style 0-10 span confidence to trace 0-1 confidence", () => {
    const trace = sanitizeTraceForIngest({
      ...baseTrace(),
      spans: [{
        node_name: "critic",
        intent: "Critic evaluation",
        start_time: 1,
        end_time: 2,
        latency_ms: 1000,
        tokens_used: 0,
        confidence: 8.4,
        outcome: "approved",
        llm_calls: [],
      }],
    });

    expect(trace.spans?.[0]?.confidence).toBeCloseTo(0.84);
  });

  it("strips control characters from nested trace metadata", () => {
    const trace = sanitizeTraceForIngest({
      ...baseTrace(),
      sensemaking: {
        planner_confidence: 0.8,
        clarification_triggered: true,
        clarification_question: "Question one?\nQuestion two?",
        assumptions: ["line one\r\nline two"],
        frame_coherence: "diffuse",
      },
      spans: [{
        node_name: "planner",
        intent: "LLM Planner",
        start_time: 1,
        end_time: 2,
        latency_ms: 1000,
        tokens_used: 0,
        confidence: 0.7,
        outcome: "clarification_triggered",
        llm_calls: [],
        metadata: {
          clarification_question: "A?\nB?",
        },
      }],
    });

    expect(trace.sensemaking?.clarification_question).toBe("Question one? Question two?");
    expect(trace.sensemaking?.assumptions[0]).toBe("line one line two");
    expect(trace.spans?.[0]?.metadata?.clarification_question).toBe("A? B?");
  });
});
