import { describe, expect, it } from "vitest";
import { invokeGraph } from "../src/graph.js";
import { runCanonicalPipeline } from "../src/pipeline.js";

describe("invokeGraph", () => {
  it("matches canonical pipeline for baseline scenario", async () => {
    const input = {
      task_description: "Design TypeScript planner migration",
      task_frame: {
        tasks: [{ description: "Migration plan" }],
        requested_format: "prose"
      }
    };
    const viaGraph = await invokeGraph(input);
    const viaPipeline = await runCanonicalPipeline(input);

    expect(viaGraph.next_node).toBe(viaPipeline.next_node);
    expect(viaGraph.plan_gate_passed).toBe(viaPipeline.plan_gate_passed);
    expect(viaGraph.critic_approved).toBe(viaPipeline.critic_approved);
  });
});
