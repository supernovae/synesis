import { describe, expect, it, vi } from "vitest";
import {
  persistGovernorPauseSoftFail,
  resetGovernorPauseRecoveryState,
} from "../src/governance/governor-pause-route.js";

function session() {
  return {
    consecutiveRecoveryFires: 2,
    governorPrePauseAttemptsByRule: new Map([["rule", 1]]),
    editReplayHardStopGraceUsed: true,
    editMissForceReadPending: true,
    history: [] as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
  };
}

describe("governor pause route helpers", () => {
  it("increments recovery count, persists pause context, usage, event, and checkpoint", () => {
    const state = session();
    const persistPauseContext = vi.fn();
    const persistSessionAndUsage = vi.fn();
    const maybeCheckpoint = vi.fn();
    const recordSessionEvent = vi.fn();

    const result = persistGovernorPauseSoftFail({
      session: state,
      sessionKey: "sess",
      identity: { userId: "user", orgId: "org" },
      requestId: "req-1",
      selectedModel: "selected",
      originalModel: "requested",
      finishReason: "stop",
      buildPause: (consecutiveRecoveryFires) => ({
        content: `pause ${consecutiveRecoveryFires}`,
        envelope: { matched_rules: ["loop"], recovery_attempts_used: consecutiveRecoveryFires } as never,
        eventType: "execution_governor_pause",
        eventSource: "execution-governor",
        eventSummary: "Pause: rules=loop",
        eventMetadata: { consecutiveRecoveryFires },
      }),
      persistPauseContext,
      persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });

    expect(state.consecutiveRecoveryFires).toBe(3);
    expect(result).toMatchObject({
      content: "pause 3",
      envelope: { recovery_attempts_used: 3 },
    });
    expect(persistPauseContext).toHaveBeenCalledWith({
      session: state,
      pauseEnvelope: { matched_rules: ["loop"], recovery_attempts_used: 3 },
      pauseContent: "pause 3",
    });
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "execution_governor_pause",
      "execution-governor",
      "Pause: rules=loop",
      "req-1",
      { consecutiveRecoveryFires: 3 },
    );
    expect(state.history).toEqual([{ role: "assistant", content: "pause 3" }]);
    expect(persistSessionAndUsage).toHaveBeenCalledWith(
      state,
      "req-1",
      "selected",
      { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      expect.any(Number),
      "stop",
      0,
      false,
      undefined,
      undefined,
      undefined,
      "requested",
    );
    expect(maybeCheckpoint).toHaveBeenCalledWith(state);
  });

  it("resets pause recovery state and clears edit recovery flags when no edit miss is active", () => {
    const state = session();
    const clearPauseContextMetadata = vi.fn();

    resetGovernorPauseRecoveryState(state, false, clearPauseContextMetadata);

    expect(state.consecutiveRecoveryFires).toBe(0);
    expect(state.governorPrePauseAttemptsByRule.size).toBe(0);
    expect(state.editReplayHardStopGraceUsed).toBe(false);
    expect(state.editMissForceReadPending).toBe(false);
    expect(clearPauseContextMetadata).toHaveBeenCalledWith(state);
  });

  it("preserves edit recovery flags when an edit miss is active", () => {
    const state = session();

    resetGovernorPauseRecoveryState(state, true, vi.fn());

    expect(state.consecutiveRecoveryFires).toBe(0);
    expect(state.editReplayHardStopGraceUsed).toBe(true);
    expect(state.editMissForceReadPending).toBe(true);
  });
});
