import { describe, expect, it, vi } from "vitest";
import { applySessionUsagePersistenceMutation } from "../src/state/session-usage-persistence.js";
import type { SessionRecord } from "../src/state/session-store.js";

function record(metadata: Record<string, unknown> = {}): SessionRecord {
  return {
    sessionKey: "s1",
    userId: "u1",
    orgId: "o1",
    conversationId: "c1",
    clientKind: "opencode",
    createdAt: 1,
    lastActiveAt: 1,
    totalTokensIn: 10,
    totalTokensOut: 2,
    totalTokensCached: 3,
    totalTokensSaved: 4,
    requestCount: 5,
    escalationCount: 0,
    consecutiveFailedVerifications: 0,
    metadata,
    version: 0,
  };
}

describe("session usage persistence mutation", () => {
  it("updates usage counters, cost totals, and trace links", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const state = {
      record: record({ last_trace_id: "prev", total_estimated_cost_usd: 0.1, total_actual_cost_usd: 0.05 }),
      consecutiveToolCalls: 0,
      stagnantToolCycles: 2,
      lastToolSignalHash: "hash",
      awaitingToolLoopUserAck: false,
      toolLoopAckAnchorUserHash: "",
      toolLoopNoUserAckCount: 0,
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: false,
    };

    const links = applySessionUsagePersistenceMutation(state, {
      requestId: "req2",
      resolvedModelId: "pulse",
      traceModel: "gpt-test",
      usage: { inputTokens: 40, outputTokens: 8, cachedTokens: 20 },
      tokensSavedByReduction: 6,
      normalizedEstimatedCostUsd: 0.25,
      normalizedActualCostUsd: 0.2,
      finishReason: "stop",
      tokenEconomicsWarnings: ["low_cache"],
    });

    expect(links).toEqual({ previousTraceId: "prev", parentTraceId: "prev", rootTraceId: "prev" });
    expect(state.record).toMatchObject({
      lastProvider: "pulse",
      lastModel: "gpt-test",
      totalTokensIn: 50,
      totalTokensOut: 10,
      totalTokensCached: 23,
      totalTokensSaved: 10,
      requestCount: 6,
      lastActiveAt: 123_456,
    });
    expect(state.record.metadata).toMatchObject({
      total_estimated_cost_usd: 0.35,
      total_actual_cost_usd: 0.25,
      root_trace_id: "prev",
      last_trace_id: "req2",
      last_cache_hit_ratio: 0.5,
      last_token_economics_warnings: ["low_cache"],
      consecutive_tool_calls: 0,
      stagnant_tool_cycles: 0,
      last_tool_signal_hash: "",
      block_broad_verification_until_edit: true,
      block_failing_verification_until_edit: false,
    });
    vi.useRealTimers();
  });

  it("increments tool-call loop counters for tool stop reasons", () => {
    const state = {
      record: record(),
      consecutiveToolCalls: 2,
      stagnantToolCycles: 1,
      lastToolSignalHash: "same",
      awaitingToolLoopUserAck: true,
      toolLoopAckAnchorUserHash: "anchor",
      toolLoopNoUserAckCount: 3,
      blockBroadVerificationUntilEdit: false,
      blockFailingVerificationUntilEdit: true,
    };

    const links = applySessionUsagePersistenceMutation(state, {
      requestId: "req1",
      resolvedModelId: "pulse",
      traceModel: "pulse",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      tokensSavedByReduction: 0,
      normalizedEstimatedCostUsd: 0,
      normalizedActualCostUsd: 0,
      finishReason: "tool_calls",
      tokenEconomicsWarnings: [],
    });

    expect(links.rootTraceId).toBe("req1");
    expect(state.consecutiveToolCalls).toBe(3);
    expect(state.record.metadata).toMatchObject({
      consecutive_tool_calls: 3,
      stagnant_tool_cycles: 1,
      last_tool_signal_hash: "same",
      awaiting_tool_loop_user_ack: true,
      tool_loop_ack_anchor_user_hash: "anchor",
      tool_loop_no_user_ack_count: 3,
      last_cache_hit_ratio: 0,
    });
  });
});
