import { describe, expect, it, vi } from "vitest";
import { applyGovernorPhaseRouteBookkeeping } from "../src/governance/governor-phase-route.js";
import type { SessionPhase } from "../src/governance/execution-governor.js";

function session(lastGovernorPhase?: SessionPhase) {
  return {
    lastGovernorPhase,
    consecutiveRecoveryFires: 3,
    governorPrePauseAttemptsByRule: new Map([["edit:rule", 1]]),
    implementationSoftStallNudgeStrikes: 1 as 0 | 1,
  };
}

describe("governor phase route bookkeeping", () => {
  it("records orchestrator/governor phase mismatch with latest user cue source", () => {
    const state = session();
    const recordSessionEvent = vi.fn();

    const result = applyGovernorPhaseRouteBookkeeping({
      session: state,
      sessionKey: "sess",
      identity: { userId: "user", orgId: "org" },
      requestId: "req-1",
      governorPhase: "edit",
      workingPhase: "planning",
      orchestratorPhaseOverride: "planning",
      messages: [{ role: "user", content: "please implement" }] as never,
      recordSessionEvent,
    });

    expect(result).toEqual({
      governorWorkflowPhase: "implementation",
      phaseTransitioned: false,
      mismatchRecorded: true,
    });
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "governor_orchestrator_phase_mismatch",
      "execution-governor",
      "working=planning governor=implementation",
      "req-1",
      expect.objectContaining({
        governor_phase: "edit",
        governor_workflow_phase: "implementation",
        orchestrator_working_phase: "planning",
        orchestrator_phase_override: "planning",
        latest_user_text_source: "user_message",
      }),
    );
    expect(state.lastGovernorPhase).toBe("edit");
  });

  it("resets recovery counters and records transition when governor phase changes", () => {
    const state = session("explore");
    const recordSessionEvent = vi.fn();

    const result = applyGovernorPhaseRouteBookkeeping({
      session: state,
      sessionKey: "sess",
      identity: { userId: "user", orgId: "org" },
      requestId: "req-1",
      governorPhase: "verify",
      messages: [],
      recordSessionEvent,
    });

    expect(result.phaseTransitioned).toBe(true);
    expect(state.consecutiveRecoveryFires).toBe(0);
    expect(state.governorPrePauseAttemptsByRule.size).toBe(0);
    expect(state.implementationSoftStallNudgeStrikes).toBe(0);
    expect(state.lastGovernorPhase).toBe("verify");
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "governor_phase_transition",
      "execution-governor",
      "explore → verify",
      "req-1",
    );
  });

  it("initializes last phase without transition event", () => {
    const state = session();
    const recordSessionEvent = vi.fn();

    const result = applyGovernorPhaseRouteBookkeeping({
      session: state,
      sessionKey: "sess",
      identity: { userId: "user", orgId: "org" },
      requestId: "req-1",
      governorPhase: "report",
      workingPhase: "validation",
      messages: [],
      recordSessionEvent,
    });

    expect(result).toEqual({
      governorWorkflowPhase: "validation",
      phaseTransitioned: false,
      mismatchRecorded: false,
    });
    expect(state.lastGovernorPhase).toBe("report");
    expect(recordSessionEvent).not.toHaveBeenCalled();
  });
});
