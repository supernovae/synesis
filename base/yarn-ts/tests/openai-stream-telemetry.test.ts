import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIStreamTelemetryInputBuilder,
  runOpenAIStreamTelemetry,
} from "../src/streaming/openai-stream-telemetry.js";
import type { OpenAIStreamFinalizerResult } from "../src/streaming/openai-stream-finalizer.js";

const verificationState = {
  round: 1,
  findings: ["missing test"],
  stalled: false,
};

function baseInput(overrides: Partial<Parameters<typeof runOpenAIStreamTelemetry>[0]> = {}) {
  const recordSessionEvent = vi.fn();
  const persistDecisionTelemetry = vi.fn();
  const pushDiagnostic = vi.fn();
  const logOptimizationLedger = vi.fn();
  const finalized: OpenAIStreamFinalizerResult = {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 3,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
    streamedText: "done",
    gateApplied: true,
    missingMust: 1,
    missingShould: 2,
    gateBlockedVerification: true,
    criticBlocked: false,
  };
  return {
    requestId: "req_1",
    sessionKey: "session_1",
    userId: "user_1",
    orgId: "org_1",
    startedAtMs: Date.now() - 250,
    finishReason: "stop",
    resolvedModelId: "model-a",
    clientRequestedModel: "model-a",
    streamFinalized: finalized,
    reductions: {
      toolResultReduction: {
        getPerRequestDelta: () => 7,
        getPerRequestGuidedTruncationDelta: () => 2,
        getPerRequestTaskPrunedDelta: () => 1,
        getLastRecallDecision: () => ({
          routing: "direct",
          resolution: { confidence: 0.75 },
        }) as never,
        getVerificationTracker: () => ({
          getState: () => verificationState,
        }),
      },
      validationNormalization: {
        getPerRequestDelta: () => 3,
      },
    },
    reducedToolResults: 4,
    orchestration: {
      phase: "build",
      tier: "pulse",
      decisionPath: "direct",
      escalated: false,
    } as never,
    policyMatchedRules: ["rule-a"],
    evidencePrefetched: true,
    evidenceConfidence: 0.8,
    evidenceAuthoritative: true,
    evidencePrefetchLatencyMs: 12,
    evidenceQuality: { quality: "ok" },
    sensemakingTriggered: true,
    sensemakingReason: "complex",
    governorDecision: null,
    governorChatStateSummary: undefined,
    governorFileStateSummary: undefined,
    optimizationLedger: {
      setUpstreamCachedTokens: vi.fn(),
      recordFinal: vi.fn(),
      finalize: vi.fn(() => ({ tokens: 1 })),
      toLogRecord: vi.fn(() => ({ total: 1 })),
    },
    normalizedMessages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    toolNames: ["Bash"],
    inferVerificationSteps: (toolNames: string[]) => toolNames.map((name) => `verify:${name}`),
    trajectoryDiagnostics: { loops: 0 },
    toolDefinitionCount: 5,
    artifactToolInjected: true,
    knowledgeToolInjected: false,
    promptProfileIds: [1],
    promptProfileHashes: ["abc"],
    prefixHash: "prefix",
    prefixChangeReasons: ["new"],
    requirementChecklistMust: 3,
    requirementChecklistShould: 4,
    contextAdmission: {
      decision: "allow" as const,
      reason: "ok",
      estimatedTokens: 100,
      estimatedChars: 400,
    },
    cacheStrategy: "anthropic_explicit",
    prefixFingerprint: "fingerprint",
    finalizeRequestForensics: vi.fn(() => ({
      summary: "summary",
      lcpRatio: 0.9,
      firstChangedSection: "messages",
      tokenEstimate: 123,
    })),
    recordSessionEvent,
    persistDecisionTelemetry,
    countMessageRoles: () => ({
      systemMessageCount: 1,
      userMessageCount: 1,
      toolMessageCount: 0,
      totalInputChars: 2,
    }),
    pushDiagnostic,
    logOptimizationLedger,
    ...overrides,
  };
}

describe("runOpenAIStreamTelemetry", () => {
  it("preserves telemetry builder identity", () => {
    const finalized = baseInput().streamFinalized;
    const builder = vi.fn(({ finishReason, finalized: streamFinalized }) => baseInput({
      finishReason,
      streamFinalized,
    }));

    const wrapped = createOpenAIStreamTelemetryInputBuilder(builder);

    expect(wrapped).toBe(builder);
    expect(wrapped({ finishReason: "tool_calls", finalized })).toMatchObject({
      finishReason: "tool_calls",
      streamFinalized: finalized,
    });
  });

  it("builds snapshot, persists telemetry, records reducer events, and pushes diagnostics", () => {
    const input = baseInput();

    const result = runOpenAIStreamTelemetry(input);

    expect(result.tokensSavedByReduction).toBe(10);
    expect(input.recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "tool_output_truncated_guided",
      component: "tool-guardrails",
      detail: "count=2",
    });
    expect(input.recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "task_conditioned_prune_applied",
      component: "tool-reducer",
      detail: "count=1",
    });
    expect(input.optimizationLedger.setUpstreamCachedTokens).toHaveBeenCalledWith(3);
    expect(input.persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      usage: input.streamFinalized.usage,
      tokensSavedByReduction: 10,
      trajectory: expect.objectContaining({
        toolSequence: ["Bash"],
        verificationSteps: ["verify:Bash"],
        completionGateBlocked: true,
        outcomeState: "partial",
        failureStage: "verification",
      }),
      optimizationLedger: { tokens: 1 },
    }));
    expect(input.pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_1",
      finishReason: "stop",
      tokensIn: 10,
      tokensOut: 5,
      completionGateApplied: true,
      missingMustRequirements: 1,
      requestForensicsSummary: "summary",
      cacheStrategy: "anthropic_explicit",
      prefixFingerprint: "fingerprint",
    }));
    expect(input.logOptimizationLedger).toHaveBeenCalledWith({ total: 1 });
  });
});
