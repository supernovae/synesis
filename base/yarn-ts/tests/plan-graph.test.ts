import { describe, expect, it } from "vitest";
import { buildTaskIntake } from "../src/planning/task-intake.js";
import { advancePlanGraph, createPlanGraph, formatPlanGraphBlock } from "../src/planning/plan-graph.js";

describe("plan graph", () => {
  it("starts at discover and advances on edits/verification", () => {
    const intake = buildTaskIntake("Build CLI and verify tests", "s1");
    const graph = createPlanGraph(intake);
    expect(graph.activeStage).toBe("discover");

    const afterEdit = advancePlanGraph(graph, { recentToolNames: ["apply_patch"] });
    expect(afterEdit.activeStage).toBe("implement");

    const afterVerify = advancePlanGraph(afterEdit, { recentToolNames: ["run_test"] });
    expect(afterVerify.activeStage).toBe("verify");
  });

  it("formats graph block", () => {
    const graph = createPlanGraph(buildTaskIntake("Do work", "s2"));
    const block = formatPlanGraphBlock(graph);
    expect(block).toContain("<synesis_plan_graph");
  });
});
