import { describe, expect, it } from "vitest";
import { planGate } from "../src/nodes/plan-gate.js";
import { runCanonicalPipeline } from "../src/pipeline.js";

describe("plan gate", () => {
  it("fails empty plans and routes back to planner", () => {
    const state = planGate({
      execution_plan: { steps: [] },
      task_frame: {},
      planner_error_count: 0
    });
    expect(state.plan_gate_passed).toBe(false);
    expect(state.next_node).toBe("planner");
    expect(state.plan_gate_errors?.some((e) => e.includes("plan_empty"))).toBe(true);
  });

  it("routes to respond after max retries", () => {
    const state = planGate({
      execution_plan: { steps: [] },
      task_frame: {},
      planner_error_count: 3
    });
    expect(state.next_node).toBe("respond");
  });

  it("passes valid plan with format references", () => {
    const state = planGate({
      execution_plan: { steps: [{ id: 1, action: "Generate structured json output with schema fields title and items" }] },
      task_frame: { requested_format: "json", output_schema: ["title", "items"] },
      evidence_packets: []
    });
    expect(state.plan_gate_passed).toBe(true);
    expect(state.next_node).toBe("router");
  });

  it("full pipeline produces response path", async () => {
    const state = await runCanonicalPipeline({
      task_description:
        "Design a comprehensive planner migration strategy that handles backward compatibility, state persistence across the TypeScript and Python runtimes, rollback procedures, and data migration for existing conversation histories",
      authz_trace_id: "trace-test-1",
      task_frame: {
        tasks: [{ description: "Migration strategy" }],
        requested_format: "prose"
      },
      execution_policy: {
        critic_background: false,
        critique_passes: 2
      }
    });
    expect(state.next_node).toBe("respond");
    expect((state.generated_code ?? "").length).toBeGreaterThan(0);
    const spans = state._span_collector?.getSpans() ?? [];
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.node_name && s.latency_ms >= 0)).toBe(true);
    expect((state.decision_ledger ?? []).some((entry) => entry.rationale.includes("authz_trace_id=trace-test-1"))).toBe(true);
  });
});
