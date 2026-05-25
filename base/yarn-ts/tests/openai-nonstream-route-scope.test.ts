import { describe, expect, it, vi } from "vitest";
import { createOpenAINonStreamRouteScope } from "../src/pipeline/openai-nonstream-route-scope.js";

describe("createOpenAINonStreamRouteScope", () => {
  it("binds event recording and decision telemetry to route identity", () => {
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const scope = createOpenAINonStreamRouteScope({
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
      metadataJson: { status: 500 },
    });
    scope.persistDecisionTelemetry({
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      latencyMs: 12,
      finishReason: "stop",
      tokensSavedByReduction: 3,
      escalated: false,
      snapshot: { schemaVersion: "decision_snapshot_v1" } as never,
      trajectory: { toolSequence: ["Read"] },
      optimizationLedger: { prefix_hash: "abc" },
    });

    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "upstream_error",
      "generateText",
      "failed",
      "req_1",
      { status: 500 },
    );
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      latencyMs: 12,
      finishReason: "stop",
      tokensSavedByReduction: 3,
      escalated: false,
      optimizationLedger: { prefix_hash: "abc" },
    }));
  });
});
