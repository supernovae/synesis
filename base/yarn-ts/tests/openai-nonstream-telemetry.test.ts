import { describe, expect, it, vi } from "vitest";
import { runOpenAINonStreamTelemetry } from "../src/pipeline/openai-nonstream-telemetry.js";

describe("runOpenAINonStreamTelemetry", () => {
  it("records reduction events, persists decision telemetry, and pushes diagnostics", () => {
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const pushDiagnostic = vi.fn();
    const logOptimizationLedger = vi.fn();
    const optimizationLedger = {
      setUpstreamCachedTokens: vi.fn(),
      recordFinal: vi.fn(),
      finalize: vi.fn(() => ({ prefix_hash: "abc" })),
      toLogRecord: vi.fn(() => ({ prefix_hash: "abc" })),
    };

    const result = runOpenAINonStreamTelemetry({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      startedAtMs: Date.now() - 10,
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 3,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
      resolvedModelId: "openai-test",
      clientRequestedModel: "openai-test",
      reductions: {
        toolResultReduction: {
          getPerRequestDelta: () => 7,
          getPerRequestGuidedTruncationDelta: () => 2,
          getPerRequestTaskPrunedDelta: () => 1,
          getLastRecallDecision: () => ({ routing: "direct", resolution: { confidence: 0.8 } }) as never,
          getVerificationTracker: () => ({
            getState: () => ({ round: 1, findings: ["missing"], stalled: true }) as never,
          }),
        },
        validationNormalization: {
          getPerRequestDelta: () => 3,
        },
      },
      reducedToolResults: 5,
      orchestration: { decisionPath: "direct", escalated: true } as never,
      policyMatchedRules: ["rule_a"],
      evidencePrefetched: true,
      evidenceConfidence: 0.9,
      evidenceAuthoritative: true,
      evidencePrefetchLatencyMs: 12,
      evidenceQuality: { source: "test" },
      diagnosticEvidencePrefetchHit: true,
      sensemakingTriggered: true,
      sensemakingReason: "hard",
      optimizationLedger,
      normalizedMessages: [{ role: "user", content: "hello" }],
      toolNames: ["Read"],
      inferVerificationSteps: (toolNames) => toolNames.map((name) => `verify:${name}`),
      trajectoryDiagnostics: { ok: true },
      gate: {
        gateApplied: true,
        missingMust: 1,
        missingShould: 2,
        gateBlockedVerification: true,
        criticBlocked: false,
      },
      toolDefinitionCount: 2,
      artifactToolInjected: true,
      knowledgeToolInjected: false,
      promptProfileIds: [1],
      promptProfileHashes: ["hash"],
      prefixHash: "prefix",
      prefixChangeReasons: ["changed"],
      requirementChecklistMust: 3,
      requirementChecklistShould: 4,
      contextAdmission: {
        decision: "allow",
        reason: "small",
        estimatedTokens: 10,
        estimatedChars: 40,
      },
      requestForensics: {
        summary: "stable",
        lcpRatio: 0.5,
        firstChangedSection: "messages",
        tokenEstimate: 32,
      },
      recordSessionEvent,
      persistDecisionTelemetry,
      countMessageRoles: () => ({
        systemMessageCount: 0,
        userMessageCount: 1,
        toolMessageCount: 0,
        totalInputChars: 5,
      }),
      pushDiagnostic,
      logOptimizationLedger,
    });

    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "tool_output_truncated_guided",
      component: "tool-guardrails",
      detail: "count=2",
    });
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "task_conditioned_prune_applied",
      component: "tool-reducer",
      detail: "count=1",
    });
    expect(optimizationLedger.setUpstreamCachedTokens).toHaveBeenCalledWith(3);
    expect(optimizationLedger.recordFinal).toHaveBeenCalledWith([{ role: "user", content: "hello" }]);
    expect(logOptimizationLedger).toHaveBeenCalledWith({ prefix_hash: "abc" });
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 12 }),
      tokensSavedByReduction: 10,
      optimizationLedger: { prefix_hash: "abc" },
      trajectory: expect.objectContaining({
        toolSequence: ["Read"],
        verificationSteps: ["verify:Read"],
        completionGateBlocked: true,
        outcomeState: "partial",
        failureStage: "verification",
      }),
    }));
    expect(pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/chat/completions",
      finishReason: "stop",
      tokensIn: 12,
      tokensOut: 4,
      policyDecision: "rule_a",
      verificationRound: 1,
      verificationFindings: 1,
      verificationStalled: true,
      evidencePrefetchHit: true,
      requestForensicsSummary: "stable",
    }));
    expect(result.tokensSavedByReduction).toBe(10);
  });
});
