import { describe, expect, it } from "vitest";
import {
  hasNonPlanImplementationWriteAfterPlanTransition,
  isSyntheticHarnessReminderText,
  neutralizeSyntheticPlanModeRemindersAfterApproval,
} from "../src/adapters/synthetic-reminders.js";

describe("synthetic harness reminders", () => {
  it("detects stale plan-mode reminders", () => {
    expect(isSyntheticHarnessReminderText(
      "<system-reminder>Plan mode is active. You MUST NOT make any edits except to the plan file.</system-reminder>",
    )).toBe(true);
    expect(isSyntheticHarnessReminderText("Plan mode is active. This is user-facing product copy.")).toBe(false);
  });

  it("neutralizes stale plan-mode reminders after approval without preserving contradictory text", () => {
    const result = neutralizeSyntheticPlanModeRemindersAfterApproval([
      { role: "user", content: "/plan Build a complete Rust workspace application." },
      { role: "tool", name: "ExitPlanMode", content: "User has approved your plan. You can now start coding." },
      {
        role: "user",
        content: "<system-reminder>Plan mode is active. You MUST NOT make any edits except to the plan file.</system-reminder>",
      },
    ]);

    expect(result.neutralizedCount).toBe(1);
    expect(result.messages[2]!.content).toContain("SYNESIS_STALE_CLIENT_REMINDER");
    expect(result.messages[2]!.content).toContain("plan approval or implementation progress has already been detected");
    expect(result.messages[2]!.content).toContain("Continue with native task setup");
    expect(result.messages[2]!.content).not.toContain("Plan mode is active");
    expect(result.messages[2]!.content).not.toContain("MUST NOT make any edits");
  });

  it("detects implementation writes after a plan transition", () => {
    expect(hasNonPlanImplementationWriteAfterPlanTransition([
      { role: "assistant", content: "Plan approved. Starting implementation of the Rust workspace project." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "w1",
          function: {
            name: "Write",
            arguments: JSON.stringify({ file_path: "Cargo.toml", content: "[workspace]\n" }),
          },
        }],
      },
      { role: "tool", tool_call_id: "w1", content: "Wrote Cargo.toml" },
      {
        role: "user",
        content: "<system-reminder>Plan mode is active. You MUST NOT make any edits except to the plan file.</system-reminder>",
      },
    ])).toBe(true);
  });

  it("does not treat plan-file writes as implementation progress", () => {
    expect(hasNonPlanImplementationWriteAfterPlanTransition([
      { role: "assistant", content: "The plan is ready for your review." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "w1",
          function: {
            name: "Write",
            arguments: JSON.stringify({ file_path: "/Users/bymiller/.claude/plans/rust-plan.md", content: "# Plan\n" }),
          },
        }],
      },
      { role: "tool", tool_call_id: "w1", content: "Updated plan" },
    ])).toBe(false);
  });
});
