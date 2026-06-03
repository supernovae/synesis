import { describe, expect, it } from "vitest";
import {
  focusRulesForEditReplay,
  isRuleAllowedInPhase,
  prioritizeMatchedRules,
} from "../src/governance/execution-governor-policy.js";

describe("execution governor policy", () => {
  it("keeps phase-specific rule admission explicit", () => {
    expect(isRuleAllowedInPhase("broad_discovery_repeat", "explore")).toBe(true);
    expect(isRuleAllowedInPhase("finalize_action_required", "explore")).toBe(false);
    expect(isRuleAllowedInPhase("finalize_action_required", "finalize")).toBe(true);
    expect(isRuleAllowedInPhase("edit_failure_replay", "verify")).toBe(false);
  });

  it("deduplicates and sorts matched rules by governor priority", () => {
    expect(prioritizeMatchedRules([
      "no_progress_loop",
      "verification_after_completion_claim",
      "no_progress_loop",
      "false_green_suspected",
      "broad_discovery_repeat",
    ])).toEqual([
      "false_green_suspected",
      "verification_after_completion_claim",
      "no_progress_loop",
      "broad_discovery_repeat",
    ]);
  });

  it("filters noisy companion rules when edit replay is terminal", () => {
    expect(focusRulesForEditReplay([
      "broad_to_narrow_verification",
      "edit_failure_replay",
      "verification_already_green",
      "no_progress_loop",
    ])).toEqual([
      "edit_failure_replay",
      "no_progress_loop",
    ]);

    expect(focusRulesForEditReplay(["broad_to_narrow_verification"])).toEqual(["broad_to_narrow_verification"]);
  });
});
