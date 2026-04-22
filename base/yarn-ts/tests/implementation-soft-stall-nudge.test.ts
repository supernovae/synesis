import { describe, expect, it } from "vitest";
import { buildImplementationSoftStallNudgeMessage, isOnlyImplementationSoftStallRules } from "../src/governance/implementation-soft-stall-nudge.js";

describe("implementation-soft-stall-nudge", () => {
  it("isOnly matches single soft rules and combinations", () => {
    expect(isOnlyImplementationSoftStallRules([])).toBe(false);
    expect(isOnlyImplementationSoftStallRules(["allow"])).toBe(false);
    expect(isOnlyImplementationSoftStallRules(["exploration_stall_no_edit"])).toBe(true);
    expect(isOnlyImplementationSoftStallRules(["no_progress_loop"])).toBe(true);
    expect(
      isOnlyImplementationSoftStallRules(["exploration_stall_no_edit", "no_progress_loop"]),
    ).toBe(true);
    expect(
      isOnlyImplementationSoftStallRules(["exploration_stall_no_edit", "verification_churn_no_edit"]),
    ).toBe(false);
  });

  it("buildImplementationSoftStallNudgeMessage includes optional governor hint", () => {
    const text = buildImplementationSoftStallNudgeMessage({ suggestedNextStep: "  Do the thing.  " });
    expect(text).toContain("IMPLEMENTATION NUDGE");
    expect(text).toContain("Do the thing");
  });
});
