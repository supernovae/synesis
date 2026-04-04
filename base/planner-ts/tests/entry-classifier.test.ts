import { describe, expect, it } from "vitest";
import { classifyEntry } from "../src/nodes/entry-classifier.js";

describe("entry classifier and effort routing", () => {
  it("takes fast path for trivial prompt", async () => {
    const state = await classifyEntry({
      task_description: "hi"
    });
    expect(state.task_is_trivial).toBe(true);
    expect(state.next_node).toBe("writer");
    expect(state.rag_mode).toBe("disabled");
    expect(state.writer_budget_target).toBeDefined();
    expect(state.writer_max_tokens).toBeGreaterThanOrEqual(state.writer_budget_target ?? 0);
  });

  it("routes complex/risky request to planner", async () => {
    const state = await classifyEntry({
      task_description:
        "Design a production migration plan with rollback safety, security compliance controls, and Kubernetes rollout strategy."
    });
    expect(state.next_node).toBe("planner");
    expect(Number(state.difficulty)).toBeGreaterThan(0.2);
    expect(typeof state.plan_required).toBe("boolean");
    expect(state.selected_effort_mode).toMatch(/pulse|core|horizon/);
  });

  it("respects explicit effort mode request", async () => {
    const state = await classifyEntry({
      task_description: "Show a quick answer",
      requested_effort_mode: "horizon"
    });
    expect(state.selected_effort_mode).toBe("horizon");
    expect(Number((state.execution_policy ?? {}).critique_passes ?? 0)).toBe(2);
  });
});
