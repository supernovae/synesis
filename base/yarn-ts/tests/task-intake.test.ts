import { describe, expect, it } from "vitest";
import { buildTaskIntake, formatTaskIntakeBlock } from "../src/planning/task-intake.js";

describe("task intake", () => {
  it("builds a staged intake with rubric scores", () => {
    const intake = buildTaskIntake(
      "Build a Go CLI with /v1/chat/completions, tests, stdin/stdout behavior, and session support",
      "abc123",
    );
    expect(intake.sourceHash).toBe("abc123");
    expect(intake.stages).toEqual(["discover", "implement", "verify", "finalize"]);
    expect(intake.rubric.overall).toBeGreaterThan(0);
    expect(intake.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("formats intake block for system guidance", () => {
    const intake = buildTaskIntake("Add integration tests and endpoint compatibility", "h1");
    const block = formatTaskIntakeBlock(intake);
    expect(block).toContain("<synesis_task_intake");
    expect(block).toContain("acceptance_criteria:");
  });
});
