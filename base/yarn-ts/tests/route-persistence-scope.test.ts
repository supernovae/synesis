import { describe, expect, it, vi } from "vitest";

import { createRoutePersistenceScope } from "../src/state/route-persistence-scope.js";

describe("createRoutePersistenceScope", () => {
  it("creates scoped session event and decision telemetry callbacks", () => {
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const state = { record: { metadata: {} } };

    const scope = createRoutePersistenceScope({
      state: state as never,
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      resolvedModelId: "model_resolved",
      clientRequestedModel: "model_client",
      recordSessionEvent,
      persistDecisionTelemetry,
    });

    scope.recordSessionEvent("event_kind", "component", "detail", { ok: true });
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "event_kind",
      "component",
      "detail",
      "req_1",
      { ok: true },
    );

    scope.persistDecisionTelemetry({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
      latencyMs: 25,
      finishReason: "stop",
      tokensSavedByReduction: 3,
      escalated: false,
      snapshot: {} as never,
      trajectory: { toolSequence: [], verificationSteps: [] },
      optimizationLedger: { cacheDiagnostics: { cacheShapeOutcome: "hit" } },
    });

    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      state,
      requestId: "req_1",
      resolvedModelId: "model_resolved",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      clientRequestedModel: "model_client",
      finishReason: "stop",
      tokensSavedByReduction: 3,
    }));
  });
});
