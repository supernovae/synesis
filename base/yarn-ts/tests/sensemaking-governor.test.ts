import { describe, it, expect } from "vitest";
import {
  computeFriction,
  computeProductiveMomentum,
  evaluateSensemakingGovernor,
  compareSensemakingWithLegacy,
  getSignalDefinition,
  buildSensemakingPauseMessage,
  buildSensemakingGuidanceInjection,
  type FrictionInput,
} from "../src/governance/sensemaking-governor.js";
import type { CommandEvent, ExecutionGovernorDecision, SessionPhase } from "../src/governance/execution-governor.js";

function makeEvent(command: string, toolName = "Bash", resultSignature = "ok"): CommandEvent {
  return { command, toolName, resultSignature };
}

function makeLegacyDecision(overrides: Partial<ExecutionGovernorDecision> = {}): ExecutionGovernorDecision {
  return {
    pause: false,
    reason: "ok",
    matchedRules: ["allow"],
    telemetry: {
      phase: "edit" as SessionPhase,
      repeatedTestCommands: 0,
      repeatedReadSearchCalls: 0,
      repeatedBroadDiscoveryCalls: 0,
      totalBroadDiscoveryCalls: 0,
      broadTestRepeat: false,
      noEditEvidence: false,
      trailingVerificationRunLength: 0,
    },
    ...overrides,
  };
}

function baseFrictionInput(overrides: Partial<FrictionInput> = {}): FrictionInput {
  return {
    matchedRules: [],
    events: [],
    phase: "edit",
    turnsSinceUserPrompt: 1,
    changedFileCount: 0,
    planRecoveryGraceActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Signal catalog
// ---------------------------------------------------------------------------

describe("signal catalog", () => {
  it("has definitions for all 35 legacy rules", () => {
    const expectedRules = [
      "exploration_stall_no_edit", "broad_discovery_repeat", "bounded_exploration_budget",
      "verbal_intent_without_action", "repeated_assistant_intro", "broad_to_narrow_verification",
      "plan_reread_loop", "source_file_stale_reread", "git_commit_followthrough",
      "cleanup_todo_harvest", "test_entry_contract", "task_creation_replay",
      "verification_churn_no_edit", "verification_stall_no_edit", "no_progress_loop",
      "verification_after_completion_claim", "completion_claim_requires_task_update",
      "verification_intent_without_action", "edit_before_retest", "no_repeat_without_change",
      "dependency_install_replay", "verification_done_report", "no_test_files_repeat",
      "verification_no_signal_repeat", "verification_truncated_output", "repeat_user_prompt_loop",
      "declaration_followthrough_required", "verification_already_green",
      "consecutive_edit_failures", "edit_failure_replay", "verification_fail_repeat_block",
      "verification_same_failure_signature_replay", "verification_green_repeat_block",
      "false_green_suspected", "finalize_action_required",
    ];
    for (const rule of expectedRules) {
      expect(getSignalDefinition(rule), `Missing signal definition for: ${rule}`).toBeDefined();
    }
  });

  it("advisory signals have low weight and high counterweight", () => {
    const advisory = getSignalDefinition("verbal_intent_without_action")!;
    expect(advisory.domain).toBe("advisory");
    expect(advisory.weight).toBeLessThan(0.15);
    expect(advisory.productiveCounterweight).toBeGreaterThan(0.7);
  });

  it("chaotic signals have high weight and low counterweight", () => {
    const chaotic = getSignalDefinition("consecutive_edit_failures")!;
    expect(chaotic.domain).toBe("chaotic");
    expect(chaotic.weight).toBeGreaterThan(0.2);
    expect(chaotic.productiveCounterweight).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// Productive momentum
// ---------------------------------------------------------------------------

describe("productive momentum", () => {
  it("returns 0 for empty events", () => {
    expect(computeProductiveMomentum([])).toBe(0);
  });

  it("returns high momentum for successful builds", () => {
    const events = [
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("bash:go test ./...", "Bash", "PASS"),
      makeEvent("bash:go vet ./...", "Bash", "ok"),
    ];
    expect(computeProductiveMomentum(events)).toBeGreaterThan(0.5);
  });

  it("returns low momentum for repeated reads without progress", () => {
    const events = [
      makeEvent("read:src/main.go", "Read", "ok"),
      makeEvent("read:src/main.go", "Read", "ok"),
      makeEvent("read:src/main.go", "Read", "ok"),
    ];
    const momentum = computeProductiveMomentum(events);
    expect(momentum).toBeLessThan(0.4);
  });

  it("returns medium momentum for mixed productive/neutral", () => {
    const events = [
      makeEvent("read:src/main.go", "Read", "ok"),
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("read:src/utils.go", "Read", "ok"),
    ];
    const momentum = computeProductiveMomentum(events);
    expect(momentum).toBeGreaterThan(0.2);
    expect(momentum).toBeLessThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// Friction score
// ---------------------------------------------------------------------------

describe("friction score", () => {
  it("returns 0 friction when no rules match", () => {
    const result = computeFriction(baseFrictionInput());
    expect(result.score).toBe(0);
    expect(result.domain).toBe("complex");
    expect(result.responseLevel).toBe("allow");
  });

  it("single advisory signal stays in complex domain", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: ["verbal_intent_without_action"],
    }));
    expect(result.score).toBeLessThan(0.25);
    expect(result.domain).toBe("complex");
    expect(result.responseLevel).toBe("allow");
  });

  it("multiple advisory signals may reach complicated_low", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: [
        "exploration_stall_no_edit",
        "broad_discovery_repeat",
        "verbal_intent_without_action",
        "repeated_assistant_intro",
        "plan_reread_loop",
      ],
    }));
    expect(result.score).toBeGreaterThan(0.15);
    expect(result.firedSignals.length).toBe(5);
  });

  it("complicated signal alone produces moderate friction", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: ["no_progress_loop"],
    }));
    expect(result.score).toBeGreaterThan(0.1);
    expect(result.score).toBeLessThan(0.55);
  });

  it("chaotic signal alone produces high friction", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: ["consecutive_edit_failures"],
    }));
    expect(result.score).toBeGreaterThan(0.25);
    expect(result.domain).not.toBe("complex");
  });

  it("multiple chaotic signals reach chaotic domain", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: [
        "consecutive_edit_failures",
        "verification_fail_repeat_block",
        "false_green_suspected",
      ],
    }));
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.domain).toBe("chaotic");
    expect(result.responseLevel).toBe("intervene");
  });

  it("productive momentum reduces advisory signal friction", () => {
    const events = [
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("bash:go test ./...", "Bash", "PASS"),
      makeEvent("edit:src/main.go", "Edit", "ok"),
    ];
    const withMomentum = computeFriction(baseFrictionInput({
      matchedRules: ["exploration_stall_no_edit", "verbal_intent_without_action"],
      events,
    }));
    const withoutMomentum = computeFriction(baseFrictionInput({
      matchedRules: ["exploration_stall_no_edit", "verbal_intent_without_action"],
      events: [],
    }));
    expect(withMomentum.score).toBeLessThan(withoutMomentum.score);
    expect(withMomentum.productiveMomentum).toBeGreaterThan(0);
  });

  it("productive momentum barely reduces chaotic signals", () => {
    const events = [
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("bash:go test ./...", "Bash", "PASS"),
      makeEvent("bash:git commit -m fix", "Bash", "ok"),
    ];
    const withMomentum = computeFriction(baseFrictionInput({
      matchedRules: ["consecutive_edit_failures"],
      events,
    }));
    const withoutMomentum = computeFriction(baseFrictionInput({
      matchedRules: ["consecutive_edit_failures"],
      events: [],
    }));
    // Chaotic signals have productiveCounterweight=0.1, so barely affected
    const reduction = 1 - (withMomentum.score / withoutMomentum.score);
    expect(reduction).toBeLessThan(0.15);
  });

  it("plan recovery grace reduces advisory and complicated signals", () => {
    const withGrace = computeFriction(baseFrictionInput({
      matchedRules: ["exploration_stall_no_edit", "completion_claim_requires_task_update"],
      planRecoveryGraceActive: true,
    }));
    const withoutGrace = computeFriction(baseFrictionInput({
      matchedRules: ["exploration_stall_no_edit", "completion_claim_requires_task_update"],
      planRecoveryGraceActive: false,
    }));
    expect(withGrace.score).toBeLessThan(withoutGrace.score);
  });

  it("signals are sorted by effective contribution descending", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: [
        "verbal_intent_without_action",
        "consecutive_edit_failures",
        "exploration_stall_no_edit",
      ],
    }));
    expect(result.firedSignals.length).toBe(3);
    for (let i = 1; i < result.firedSignals.length; i++) {
      expect(result.firedSignals[i - 1].effectiveContribution)
        .toBeGreaterThanOrEqual(result.firedSignals[i].effectiveContribution);
    }
  });
});

// ---------------------------------------------------------------------------
// Domain classification
// ---------------------------------------------------------------------------

describe("domain classification", () => {
  it("no signals -> complex/allow", () => {
    const result = computeFriction(baseFrictionInput());
    expect(result.domain).toBe("complex");
    expect(result.responseLevel).toBe("allow");
  });

  it("moderate complicated signals -> complicated_low/nudge", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: ["verification_churn_no_edit", "no_progress_loop"],
    }));
    expect(result.domain).toBe("complicated_low");
    expect(result.responseLevel).toBe("nudge");
  });

  it("heavy complicated signals -> complicated_high/guide", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: [
        "verification_churn_no_edit",
        "no_progress_loop",
        "verification_stall_no_edit",
        "edit_before_retest",
        "no_repeat_without_change",
      ],
    }));
    expect(["complicated_high", "chaotic"]).toContain(result.domain);
    expect(["guide", "intervene"]).toContain(result.responseLevel);
  });

  it("chaotic signals -> chaotic/intervene", () => {
    const result = computeFriction(baseFrictionInput({
      matchedRules: [
        "consecutive_edit_failures",
        "verification_fail_repeat_block",
        "verification_same_failure_signature_replay",
      ],
    }));
    expect(result.domain).toBe("chaotic");
    expect(result.responseLevel).toBe("intervene");
  });
});

// ---------------------------------------------------------------------------
// Shadow comparison
// ---------------------------------------------------------------------------

describe("sensemaking shadow comparison", () => {
  it("agrees when legacy allows and sensemaking sees complex domain", () => {
    const legacy = makeLegacyDecision({ pause: false, matchedRules: ["allow"] });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    const comparison = compareSensemakingWithLegacy(legacy, sm);
    expect(comparison.agreement).toBe(true);
    expect(comparison.legacyPause).toBe(false);
    expect(comparison.sensemakingResponse).toBe("allow");
    expect(comparison.sensemakingMorePermissive).toBe(false);
    expect(comparison.sensemakingMoreRestrictive).toBe(false);
  });

  it("detects when sensemaking is more permissive than legacy", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "exploration_stall_no_edit",
      matchedRules: ["exploration_stall_no_edit"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    const comparison = compareSensemakingWithLegacy(legacy, sm);
    // Single advisory signal should not cause sensemaking to intervene
    expect(comparison.sensemakingMorePermissive).toBe(true);
    expect(comparison.legacyPause).toBe(true);
    expect(comparison.sensemakingResponse).not.toBe("intervene");
  });

  it("agrees on chaotic situations", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "consecutive_edit_failures",
      matchedRules: ["consecutive_edit_failures", "edit_failure_replay", "verification_fail_repeat_block"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    const comparison = compareSensemakingWithLegacy(legacy, sm);
    expect(comparison.domain).toBe("chaotic");
    expect(comparison.sensemakingResponse).toBe("intervene");
    expect(comparison.agreement).toBe(true);
  });

  it("provides guidance for nudge/guide responses", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "no_progress_loop",
      matchedRules: ["no_progress_loop", "verification_churn_no_edit"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    expect(sm.guidance).toBeDefined();
    expect(sm.guidance!.length).toBeGreaterThan(10);
  });

  it("productive events improve sensemaking permissiveness", () => {
    const events = [
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("bash:go test ./pkg/...", "Bash", "PASS"),
      makeEvent("edit:src/main.go", "Edit", "ok"),
    ];
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "exploration_stall_no_edit",
      matchedRules: ["exploration_stall_no_edit", "broad_discovery_repeat"],
    });
    const smWithEvents = evaluateSensemakingGovernor(legacy, events, 1, 0, false);
    const smWithoutEvents = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    expect(smWithEvents.frictionScore).toBeLessThan(smWithoutEvents.frictionScore);
    expect(smWithEvents.productiveMomentum).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real-world scenario tests
// ---------------------------------------------------------------------------

describe("real-world scenarios", () => {
  it("plan resume: legacy pauses but sensemaking allows orientation", () => {
    // This is the exact scenario that caused the stuck loop:
    // model reads plan, reads files, governor fires completion_claim + no_progress
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "completion_claim_requires_task_update",
      matchedRules: ["completion_claim_requires_task_update", "no_progress_loop", "exploration_stall_no_edit"],
    });
    const events = [
      makeEvent("read:~/.claude/plans/happy-beaming-lollipop.md", "Read", "ok"),
      makeEvent("read:src/main.go", "Read", "ok"),
      makeEvent("read:src/utils.go", "Read", "ok"),
    ];
    const sm = evaluateSensemakingGovernor(legacy, events, 3, 0, true);
    // With plan recovery grace and neutral momentum, should not intervene
    expect(sm.responseLevel).not.toBe("intervene");
    expect(sm.domain).not.toBe("chaotic");
  });

  it("genuine runaway loop: sensemaking escalates appropriately", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "verification_fail_repeat_block",
      matchedRules: ["verification_fail_repeat_block", "no_progress_loop", "verification_churn_no_edit"],
    });
    const events = [
      makeEvent("bash:go test ./...", "Bash", "FAIL: exit code 1"),
      makeEvent("bash:go test ./...", "Bash", "FAIL: exit code 1"),
      makeEvent("bash:go test ./...", "Bash", "FAIL: exit code 1"),
      makeEvent("bash:go test ./...", "Bash", "FAIL: exit code 1"),
    ];
    // turnsSinceUserPrompt=1 means this is a fresh evaluation, not decayed
    const sm = evaluateSensemakingGovernor(legacy, events, 1, 0, false);
    // 1 chaotic + 2 complicated signals with no decay = high friction
    expect(["complicated_high", "chaotic"]).toContain(sm.domain);
    expect(["guide", "intervene"]).toContain(sm.responseLevel);
    expect(sm.frictionScore).toBeGreaterThan(0.55);
  });

  it("severe runaway: multiple chaotic signals reach intervene", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "consecutive_edit_failures",
      matchedRules: [
        "consecutive_edit_failures",
        "edit_failure_replay",
        "verification_fail_repeat_block",
        "verification_same_failure_signature_replay",
      ],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    expect(sm.responseLevel).toBe("intervene");
    expect(sm.domain).toBe("chaotic");
    expect(sm.frictionScore).toBeGreaterThan(0.80);
  });

  it("productive model with advisory signals: sensemaking allows", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      reason: "exploration_stall_no_edit",
      matchedRules: ["exploration_stall_no_edit", "broad_discovery_repeat"],
    });
    const events = [
      makeEvent("bash:go build ./...", "Bash", "exit code 0"),
      makeEvent("edit:src/handler.go", "Edit", "ok"),
      makeEvent("bash:go test ./pkg/handler/...", "Bash", "PASS"),
      makeEvent("bash:git add -A && git commit -m feat", "Bash", "ok"),
    ];
    const sm = evaluateSensemakingGovernor(legacy, events, 4, 1, false);
    expect(sm.responseLevel).toBe("allow");
    expect(sm.productiveMomentum).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Primary decision-maker features
// ---------------------------------------------------------------------------

describe("primary decision-maker features", () => {
  it("shouldPause is true only for intervene responses", () => {
    // chaotic -> intervene -> shouldPause
    const chaotic = makeLegacyDecision({
      pause: true,
      matchedRules: ["consecutive_edit_failures", "edit_failure_replay", "verification_fail_repeat_block"],
    });
    const smChaotic = evaluateSensemakingGovernor(chaotic, [], 1, 0, false);
    expect(smChaotic.shouldPause).toBe(true);

    // advisory -> allow -> no pause
    const advisory = makeLegacyDecision({
      pause: true,
      matchedRules: ["verbal_intent_without_action"],
    });
    const smAdvisory = evaluateSensemakingGovernor(advisory, [], 1, 0, false);
    expect(smAdvisory.shouldPause).toBe(false);
  });

  it("shouldRestrictDiscovery is false during plan recovery grace", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      matchedRules: ["no_progress_loop", "verification_churn_no_edit", "verification_stall_no_edit"],
    });
    // guide-level friction, but with plan recovery grace
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, true);
    expect(sm.shouldRestrictDiscovery).toBe(false);
  });

  it("shouldRestrictDiscovery is true for guide without plan grace", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      matchedRules: ["no_progress_loop", "verification_churn_no_edit", "verification_stall_no_edit", "edit_before_retest", "no_repeat_without_change"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    if (sm.responseLevel === "guide" || sm.responseLevel === "intervene") {
      expect(sm.shouldRestrictDiscovery).toBe(true);
    }
  });

  it("matchedRules excludes the allow sentinel", () => {
    const legacy = makeLegacyDecision({
      pause: false,
      matchedRules: ["allow", "exploration_stall_no_edit"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    expect(sm.matchedRules).not.toContain("allow");
    expect(sm.matchedRules).toContain("exploration_stall_no_edit");
  });
});

// ---------------------------------------------------------------------------
// Pause and guidance message builders
// ---------------------------------------------------------------------------

describe("message builders", () => {
  it("buildSensemakingPauseMessage includes domain and friction", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      matchedRules: ["consecutive_edit_failures", "edit_failure_replay", "verification_fail_repeat_block"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    const msg = buildSensemakingPauseMessage(sm);
    expect(msg).toContain("Governor pause");
    expect(msg).toContain("chaotic");
  });

  it("buildSensemakingGuidanceInjection returns null for allow", () => {
    const legacy = makeLegacyDecision({ matchedRules: ["allow"] });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    expect(buildSensemakingGuidanceInjection(sm)).toBeNull();
  });

  it("buildSensemakingGuidanceInjection returns hint for nudge", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      matchedRules: ["no_progress_loop", "verification_churn_no_edit"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    if (sm.responseLevel === "nudge") {
      const msg = buildSensemakingGuidanceInjection(sm);
      expect(msg).not.toBeNull();
      expect(msg!).toContain("[Hint]");
    }
  });

  it("buildSensemakingGuidanceInjection returns guidance for guide", () => {
    const legacy = makeLegacyDecision({
      pause: true,
      matchedRules: ["no_progress_loop", "verification_churn_no_edit", "verification_stall_no_edit", "edit_before_retest", "no_repeat_without_change"],
    });
    const sm = evaluateSensemakingGovernor(legacy, [], 1, 0, false);
    if (sm.responseLevel === "guide") {
      const msg = buildSensemakingGuidanceInjection(sm);
      expect(msg).not.toBeNull();
      expect(msg!).toContain("[Guidance]");
    }
  });
});
