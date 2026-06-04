import { describe, expect, it } from "vitest";
import {
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
    expect(result.messages[2]!.content).toContain("plan approval has already been detected");
    expect(result.messages[2]!.content).toContain("Continue with native task setup");
    expect(result.messages[2]!.content).not.toContain("Plan mode is active");
    expect(result.messages[2]!.content).not.toContain("MUST NOT make any edits");
  });
});
