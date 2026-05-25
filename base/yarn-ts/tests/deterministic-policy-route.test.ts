import { describe, expect, it, vi } from "vitest";
import {
  handleDeterministicPolicyPrecheck,
  repeatLoopSoftFailMessage,
  toolLoopSoftFailMessage,
} from "../src/policy/deterministic-policy-route.js";
import type { PolicyDecision } from "../src/policy/deterministic-policy-engine.js";

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    allow: true,
    matchedRules: [],
    ...overrides,
  };
}

function session() {
  return {
    awaitingToolLoopUserAck: false,
    toolLoopAckAnchorUserHash: "",
    toolLoopNoUserAckCount: 7,
    record: { totalTokensIn: 123 },
    history: [] as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
  };
}

function input(overrides: Partial<Parameters<typeof handleDeterministicPolicyPrecheck>[0]> = {}) {
  return {
    decision: decision(),
    softFailEnabled: true,
    session: session(),
    sessionKey: "sess",
    identity: { userId: "user", orgId: "org" },
    requestId: "req-1",
    selectedModel: "selected",
    originalModel: "requested",
    latestUserHash: "user-hash",
    finishReason: "stop",
    logSafetyEvent: vi.fn(),
    persistSessionAndUsage: vi.fn(),
    maybeCheckpoint: vi.fn(),
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("deterministic policy route helper", () => {
  it("continues when policy allows", () => {
    const routeInput = input();

    expect(handleDeterministicPolicyPrecheck(routeInput)).toEqual({ kind: "continue" });
    expect(routeInput.logSafetyEvent).not.toHaveBeenCalled();
  });

  it("persists tool-loop soft fail and arms user ack state", () => {
    const routeInput = input({
      decision: decision({
        allow: false,
        rejectReason: "too many tool calls",
        softFailClass: "tool_loop",
        matchedRules: ["consecutive_tool_calls_limit"],
      }),
    });

    const action = handleDeterministicPolicyPrecheck(routeInput);

    expect(action).toMatchObject({ kind: "softFail", eventType: "tool_loop_soft_fail" });
    expect(routeInput.session.awaitingToolLoopUserAck).toBe(true);
    expect(routeInput.session.toolLoopAckAnchorUserHash).toBe("user-hash");
    expect(routeInput.session.toolLoopNoUserAckCount).toBe(0);
    expect(routeInput.session.history[0]?.content).toContain("too many tool calls");
    expect(routeInput.persistSessionAndUsage).toHaveBeenCalledWith({
      state: routeInput.session,
      requestId: "req-1",
      resolvedModelId: "selected",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      latencyMs: expect.any(Number),
      finishReason: "stop",
      tokensSavedByReduction: 0,
      escalated: false,
      clientRequestedModel: "requested",
    });
    expect(routeInput.recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "tool_loop_soft_fail",
      "deterministic-policy",
      "too many tool calls",
      "req-1",
    );
  });

  it("persists repeat-loop soft fail without changing ack state", () => {
    const routeInput = input({
      decision: decision({
        allow: false,
        rejectReason: "same request again",
        matchedRules: ["repeat_loop_hard_reject"],
      }),
    });

    const action = handleDeterministicPolicyPrecheck(routeInput);

    expect(action).toMatchObject({ kind: "softFail", eventType: "repeat_loop_soft_fail" });
    expect(routeInput.session.awaitingToolLoopUserAck).toBe(false);
    expect(routeInput.session.toolLoopNoUserAckCount).toBe(7);
    expect(routeInput.session.history[0]?.content).toContain("same request again");
  });

  it("returns reject for hard policy rejections that are not soft-failed", () => {
    const routeInput = input({
      decision: decision({
        allow: false,
        rejectReason: "budget exceeded",
        matchedRules: ["session_budget_exceeded"],
      }),
    });

    expect(handleDeterministicPolicyPrecheck(routeInput)).toEqual({
      kind: "reject",
      decision: routeInput.decision,
    });
    expect(routeInput.persistSessionAndUsage).not.toHaveBeenCalled();
  });

  it("keeps soft-fail message text stable", () => {
    expect(toolLoopSoftFailMessage(decision({ allow: false, rejectReason: "reason" }))).toContain("repair loop");
    expect(repeatLoopSoftFailMessage(decision({ allow: false, rejectReason: "reason" }))).toContain("new chat/session");
  });
});
