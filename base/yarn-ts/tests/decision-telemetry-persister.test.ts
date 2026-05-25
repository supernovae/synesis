import { describe, expect, it, vi } from "vitest";

import {
  buildDecisionTelemetryPersistenceInput,
  createDecisionTelemetryPersister,
} from "../src/state/decision-telemetry-persister.js";

function context() {
  return {
    state: { id: "state" },
    requestId: "req-1",
    resolvedModelId: "resolved-model",
    sessionKey: "session-1",
    userId: "user-1",
    orgId: "org-1",
    clientRequestedModel: "requested-model",
  };
}

function payload() {
  return {
    usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4, cacheCreationTokens: 1, costUsd: 0.01 },
    latencyMs: 123,
    finishReason: "stop",
    tokensSavedByReduction: 7,
    escalated: true,
    snapshot: { decisionPath: "test" },
    trajectory: { toolSequence: ["Read"], verificationSteps: ["pytest"] },
    optimizationLedger: { prefixStableBytes: 42 },
  };
}

describe("decision telemetry persister", () => {
  it("combines route context with per-request telemetry payload", () => {
    expect(buildDecisionTelemetryPersistenceInput(context() as never, payload() as never)).toEqual({
      state: { id: "state" },
      requestId: "req-1",
      resolvedModelId: "resolved-model",
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4, cacheCreationTokens: 1, costUsd: 0.01 },
      latencyMs: 123,
      finishReason: "stop",
      tokensSavedByReduction: 7,
      escalated: true,
      snapshot: { decisionPath: "test" },
      trajectory: { toolSequence: ["Read"], verificationSteps: ["pytest"] },
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      optimizationLedger: { prefixStableBytes: 42 },
      clientRequestedModel: "requested-model",
    });
  });

  it("creates a scoped persistence callback", () => {
    const persist = vi.fn();
    const scoped = createDecisionTelemetryPersister(context() as never, persist);

    scoped(payload() as never);

    expect(persist).toHaveBeenCalledWith(buildDecisionTelemetryPersistenceInput(context() as never, payload() as never));
  });
});
