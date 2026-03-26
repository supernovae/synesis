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
      task_description: "Design planner migration strategy",
      authz_trace_id: "trace-test-1",
      task_frame: {
        tasks: [{ description: "Migration strategy" }],
        requested_format: "prose"
      }
    });
    expect(state.next_node).toBe("respond");
    expect((state.generated_code ?? "").length).toBeGreaterThan(0);
    const traces = (state.node_traces ?? []) as Array<{ node_name?: string; authz_trace_id?: string }>;
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((trace) => trace.authz_trace_id === "trace-test-1")).toBe(true);
    expect((state.decision_ledger ?? []).some((entry) => entry.rationale.includes("authz_trace_id=trace-test-1"))).toBe(true);
  });
});
