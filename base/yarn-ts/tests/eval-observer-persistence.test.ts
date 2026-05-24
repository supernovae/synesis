import { describe, expect, it, vi } from "vitest";
import { runEvalObserverPersistence } from "../src/eval/session-observer-persistence.js";
import type { DecisionSnapshot } from "../src/telemetry/decision-snapshot.js";

function snapshot(overrides: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    decisionPath: "test",
    phase: "test",
    tier: "synesis-core",
    escalated: false,
    policyDecision: "allow",
    reducedToolResults: 0,
    tokensSavedByReduction: 0,
    isStreaming: false,
    ...overrides,
  };
}

describe("eval observer persistence runner", () => {
  it("records transcript and live eval events when observing a paused turn", () => {
    const recordSessionEvent = vi.fn();

    runEvalObserverPersistence({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-1",
      history: [
        { role: "user", content: "please build this" },
        { role: "assistant", content: "GOVERNOR PAUSE: blocked" },
      ],
      snapshot: snapshot({
        governor: {
          pause: true,
          reason: "blocked",
          matchedRules: ["test_rule"],
          telemetry: {} as never,
        },
      }),
      recordSessionEvent,
      isEnabled: () => true,
      shouldObserve: () => true,
    });

    expect(recordSessionEvent).toHaveBeenCalledTimes(2);
    expect(recordSessionEvent.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-1",
      eventKind: "eval_transcript_v1",
      component: "eval-observer",
      metadataJson: {
        schema_version: "eval_transcript_v1",
        session_key: "session-1",
        request_id: "req-1",
        governor_pause: true,
        governor_rules: ["test_rule"],
      },
    });
    expect(recordSessionEvent.mock.calls[1]?.[0]).toMatchObject({
      eventKind: "live_eval_v1",
      metadataJson: {
        schema_version: "live_eval_v1",
        governor_pause: true,
        governor_rules: ["test_rule"],
      },
    });
  });

  it("skips work when observer is disabled or session is filtered out", () => {
    const recordSessionEvent = vi.fn();

    runEvalObserverPersistence({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-1",
      history: [{ role: "user", content: "hello" }],
      snapshot: snapshot(),
      recordSessionEvent,
      isEnabled: () => false,
      shouldObserve: () => true,
    });
    runEvalObserverPersistence({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-2",
      history: [{ role: "user", content: "hello" }],
      snapshot: snapshot(),
      recordSessionEvent,
      isEnabled: () => true,
      shouldObserve: () => false,
    });

    expect(recordSessionEvent).not.toHaveBeenCalled();
  });

  it("reports observer write failures through the warning hook", () => {
    const err = new Error("write failed");
    const warn = vi.fn();

    runEvalObserverPersistence({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "req-1",
      history: [{ role: "user", content: "hello" }],
      snapshot: snapshot(),
      recordSessionEvent: () => {
        throw err;
      },
      isEnabled: () => true,
      shouldObserve: () => true,
      warn,
    });

    expect(warn).toHaveBeenCalledWith(err);
  });
});
