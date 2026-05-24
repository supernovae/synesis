import { describe, expect, it, vi } from "vitest";
import { runClaudeNonStreamTelemetry } from "../src/streaming/claude-nonstream-telemetry.js";

describe("runClaudeNonStreamTelemetry", () => {
  it("persists non-stream decision telemetry and pushes diagnostic fields", () => {
    const startedAtMs = Date.now() - 250;
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const pushDiagnostic = vi.fn();

    const result = runClaudeNonStreamTelemetry({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      startedAtMs,
      finishReason: "end_turn",
      resolvedModelId: "claude-test",
      clientRequestedModel: "claude-requested",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedTokens: 10,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
      reductions: {
        toolResultReduction: {
          getPerRequestDelta: () => 12,
          getPerRequestGuidedTruncationDelta: () => 2,
          getPerRequestTaskPrunedDelta: () => 1,
          getLastRecallDecision: () => ({ routing: "hit", resolution: { confidence: 0.8 } }) as never,
          getVerificationTracker: () => ({
            getState: () => ({ round: 1, findings: ["ok"], stalled: true }) as never,
          }),
        },
        validationNormalization: {
          getPerRequestDelta: () => 3,
        },
      },
      reducedToolResults: 4,
      orchestration: { decisionPath: "direct", escalated: true } as never,
      policyMatchedRules: ["rule-a"],
      evidencePrefetched: true,
      evidencePrefetchHit: true,
      evidenceConfidence: 0.7,
      evidenceAuthoritative: true,
      evidencePrefetchLatencyMs: 15,
      evidenceQuality: { source: "test" },
      sensemakingTriggered: true,
      sensemakingReason: "need_context",
      normalizedMessages: [{ role: "user", content: "hello" }],
      toolNames: ["Read", "Bash"],
      inferVerificationSteps: (tools) => tools.filter((tool) => tool === "Bash"),
      trajectoryDiagnostics: { loops: 0 },
      gate: {
        applied: true,
        missingMust: 1,
        missingShould: 2,
        blockedVerification: true,
        criticBlocked: false,
      },
      toolDefinitionCount: 8,
      artifactToolInjected: true,
      knowledgeToolInjected: false,
      promptProfileIds: [1],
      promptProfileHashes: ["abc"],
      prefixHash: "prefix",
      prefixChangeReasons: ["changed"],
      requirementChecklistMust: 3,
      requirementChecklistShould: 4,
      contextAdmission: {
        decision: "allow",
        reason: "small",
        estimatedTokens: 5,
        estimatedChars: 20,
      },
      requestForensicsDone: {
        summary: "stable",
        lcpRatio: 0.9,
        firstChangedSection: "messages",
        tokenEstimate: 200,
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
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "end_turn",
      tokensSavedByReduction: 15,
      escalated: true,
      trajectory: expect.objectContaining({
        toolSequence: ["Read", "Bash"],
        verificationSteps: ["Bash"],
        completionGateBlocked: true,
        outcomeState: "partial",
        failureStage: "verification",
      }),
    }));
    expect(pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/messages",
      requestId: "req_1",
      policyDecision: "rule-a",
      tokensIn: 100,
      tokensOut: 25,
      recallRouting: "hit",
      evidencePrefetchHit: true,
      completionGateApplied: true,
      requestForensicsSummary: "stable",
    }));
    expect(result.tokensSavedByReduction).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.snapshot).toEqual(expect.any(Object));
  });
});
