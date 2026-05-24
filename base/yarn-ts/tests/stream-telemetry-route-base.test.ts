import { describe, expect, it, vi } from "vitest";
import { createStreamTelemetryRouteBase } from "../src/streaming/stream-telemetry-route-base.js";

describe("createStreamTelemetryRouteBase", () => {
  it("binds stream scope identity and preserves common telemetry fields", () => {
    const reductions = {
      toolResultReduction: {
        getPerRequestDelta: () => 1,
        getPerRequestGuidedTruncationDelta: () => 0,
        getPerRequestTaskPrunedDelta: () => 0,
        getLastRecallDecision: () => null,
        getVerificationTracker: () => ({ getState: () => ({ round: 0, findings: [], stalled: false }) }),
      },
      validationNormalization: {
        getPerRequestDelta: () => 2,
      },
    };
    const inferVerificationSteps = vi.fn((tools: string[]) => tools.map((tool) => `verify:${tool}`));
    const countMessageRoles = vi.fn();
    const pushDiagnostic = vi.fn();

    const base = createStreamTelemetryRouteBase({
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
      },
      startedAtMs: 123,
      resolvedModelId: "model-a",
      clientRequestedModel: "model-request",
      reductions,
      reducedToolResults: 4,
      orchestration: { decisionPath: "direct", escalated: false } as never,
      policyMatchedRules: ["rule-a"],
      evidencePrefetched: true,
      evidenceConfidence: 0.75,
      evidenceAuthoritative: true,
      evidencePrefetchLatencyMs: 12,
      evidenceQuality: { quality: "ok" },
      sensemakingTriggered: true,
      sensemakingReason: "complex",
      governorDecision: null,
      governorChatStateSummary: { chat: "ok" },
      governorFileStateSummary: { files: "ok" },
      normalizedMessages: [{ role: "user", content: "hello" }],
      inferVerificationSteps,
      trajectoryDiagnostics: { loops: 0 },
      toolDefinitionCount: 3,
      artifactToolInjected: true,
      knowledgeToolInjected: false,
      promptProfileIds: [1],
      promptProfileHashes: ["hash"],
      prefixHash: "prefix",
      prefixChangeReasons: ["new"],
      requirementChecklistMust: 2,
      requirementChecklistShould: 1,
      contextAdmission: { decision: "allow", reason: "ok" },
      cacheStrategy: "anthropic_explicit",
      prefixFingerprint: "fingerprint",
      countMessageRoles,
      pushDiagnostic,
    });

    expect(base).toEqual(expect.objectContaining({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      startedAtMs: 123,
      resolvedModelId: "model-a",
      clientRequestedModel: "model-request",
      reductions,
      reducedToolResults: 4,
      policyMatchedRules: ["rule-a"],
      evidencePrefetched: true,
      evidenceConfidence: 0.75,
      normalizedMessages: [{ role: "user", content: "hello" }],
      inferVerificationSteps,
      countMessageRoles,
      pushDiagnostic,
      cacheStrategy: "anthropic_explicit",
      prefixFingerprint: "fingerprint",
    }));
  });
});
