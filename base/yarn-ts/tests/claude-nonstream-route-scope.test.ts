import { describe, expect, it, vi } from "vitest";
import { createClaudeNonStreamRouteScope } from "../src/streaming/claude-nonstream-route-scope.js";

describe("createClaudeNonStreamRouteScope", () => {
  it("binds route identity to event recording and persistence", () => {
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const scope = createClaudeNonStreamRouteScope({
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      recordSessionEvent,
      persistDecisionTelemetry,
    });

    scope.recordEvent({
      eventKind: "upstream_error",
      component: "generateText",
      detail: "failed",
      metadataJson: { code: "rate_limit" },
    });
    scope.persistDecisionTelemetry({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cachedTokens: 1,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
      latencyMs: 25,
      finishReason: "end_turn",
      tokensSavedByReduction: 3,
      escalated: false,
      snapshot: { schemaVersion: "decision_snapshot_v1" } as never,
      trajectory: { toolSequence: ["Read"] },
    });

    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "upstream_error",
      "generateText",
      "failed",
      "req_1",
      { code: "rate_limit" },
    );
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      latencyMs: 25,
      finishReason: "end_turn",
      tokensSavedByReduction: 3,
      escalated: false,
      trajectory: { toolSequence: ["Read"] },
    }));
  });
});
