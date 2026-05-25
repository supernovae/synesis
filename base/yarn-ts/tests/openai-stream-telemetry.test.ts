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
      recordCacheDiagnostics: vi.fn(),
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
  it("builds telemetry input from route dependencies", () => {
    const base = baseInput();
    const finalized = base.streamFinalized;
    const persistDecisionTelemetry = vi.fn();
    const builder = createOpenAIStreamTelemetryInputBuilder({
      requestId: base.requestId,
      sessionKey: base.sessionKey,
      userId: base.userId,
      orgId: base.orgId,
      startedAtMs: base.startedAtMs,
      resolvedModelId: base.resolvedModelId,
      clientRequestedModel: base.clientRequestedModel,
      reductions: base.reductions,
      reducedToolResults: base.reducedToolResults,
      orchestration: base.orchestration,
      policyMatchedRules: base.policyMatchedRules,
      evidencePrefetched: base.evidencePrefetched,
      evidenceConfidence: base.evidenceConfidence,
      evidenceAuthoritative: base.evidenceAuthoritative,
      evidencePrefetchLatencyMs: base.evidencePrefetchLatencyMs,
      evidenceQuality: base.evidenceQuality,
      sensemakingTriggered: base.sensemakingTriggered,
      sensemakingReason: base.sensemakingReason,
      governorDecision: base.governorDecision,
      governorChatStateSummary: base.governorChatStateSummary,
      governorFileStateSummary: base.governorFileStateSummary,
      optimizationLedger: base.optimizationLedger,
      normalizedMessages: base.normalizedMessages,
      getToolNames: () => ["Bash", "Read"],
      inferVerificationSteps: base.inferVerificationSteps,
      trajectoryDiagnostics: base.trajectoryDiagnostics,
      toolDefinitionCount: base.toolDefinitionCount,
      artifactToolInjected: base.artifactToolInjected,
      knowledgeToolInjected: base.knowledgeToolInjected,
      promptProfileIds: base.promptProfileIds,
      promptProfileHashes: base.promptProfileHashes,
      prefixHash: base.prefixHash,
      prefixChangeReasons: base.prefixChangeReasons,
      requirementChecklistMust: base.requirementChecklistMust,
      requirementChecklistShould: base.requirementChecklistShould,
      contextAdmission: base.contextAdmission,
      cacheStrategy: base.cacheStrategy,
      prefixFingerprint: base.prefixFingerprint,
      finalizeRequestForensics: base.finalizeRequestForensics,
      recordSessionEvent: base.recordSessionEvent,
      persistDecisionTelemetry,
      countMessageRoles: base.countMessageRoles,
      pushDiagnostic: base.pushDiagnostic,
      logOptimizationLedger: base.logOptimizationLedger,
    });

    const built = builder({ finishReason: "tool_calls", finalized });

    expect(built).toMatchObject({
      finishReason: "tool_calls",
      streamFinalized: finalized,
      toolNames: ["Bash", "Read"],
    });
    built.persistDecisionTelemetry({
      usage: finalized.usage,
      latencyMs: 1,
      tokensSavedByReduction: 2,
      snapshot: {} as never,
      trajectory: {
        toolSequence: [],
        verificationSteps: [],
      },
      optimizationLedger: {},
    });
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "tool_calls",
    }));
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
    expect(input.optimizationLedger.recordCacheDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      cacheShapePromptTokens: 10,
      cacheShapeCachedTokens: 3,
      cacheShapeCacheCreationTokens: 0,
      cacheShapeHitPct: 30,
      cacheShapeOutcome: "hit",
    }));
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
