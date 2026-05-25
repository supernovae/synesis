import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamTelemetryInput,
  runClaudeStreamTelemetry,
} from "../src/streaming/claude-stream-telemetry.js";

const verificationState = {
  round: 1,
  findings: ["missing verification"],
  stalled: false,
};

function baseInput(overrides: Partial<Parameters<typeof runClaudeStreamTelemetry>[0]> = {}) {
  const recordSessionEvent = vi.fn();
  const persistDecisionTelemetry = vi.fn();
  const pushDiagnostic = vi.fn();
  return {
    requestId: "req_1",
    sessionKey: "session_1",
    userId: "user_1",
    orgId: "org_1",
    startedAtMs: Date.now() - 250,
    finishReason: "stop",
    resolvedModelId: "claude-model",
    clientRequestedModel: "claude-model",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 3,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
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
    normalizedMessages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    toolNames: ["Bash"],
    inferVerificationSteps: (toolNames: string[]) => toolNames.map((name) => `verify:${name}`),
    trajectoryDiagnostics: { loops: 0 },
    gate: {
      applied: true,
      missingMust: 1,
      missingShould: 2,
      blockedVerification: true,
      criticBlocked: false,
    },
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
    cacheShapeDiagnostics: {
      messageCount: 2,
      stablePrefixHash: "stable-prefix",
      stablePrefixBytes: 100,
      toolCount: 3,
      toolSchemaHash: "tool-schema",
      toolSchemaBytes: 200,
      providerOptionsHash: "provider-options",
      providerOptionsBytes: 50,
    },
    requestForensicsDone: {
      summary: "summary",
      lcpRatio: 0.9,
      firstChangedSection: "messages",
      tokenEstimate: 123,
    },
    recordSessionEvent,
    persistDecisionTelemetry,
    countMessageRoles: () => ({
      systemMessageCount: 1,
      userMessageCount: 1,
      toolMessageCount: 0,
      totalInputChars: 2,
    }),
    pushDiagnostic,
    ...overrides,
  };
}

describe("runClaudeStreamTelemetry", () => {
  it("builds snapshot, persists telemetry, records reducer events, and pushes Claude diagnostics", () => {
    const input = baseInput();

    const result = runClaudeStreamTelemetry(input);

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
    expect(input.persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      usage: input.usage,
      finishReason: "stop",
      tokensSavedByReduction: 10,
      escalated: false,
      trajectory: expect.objectContaining({
        toolSequence: ["Bash"],
        verificationSteps: ["verify:Bash"],
        completionGateBlocked: true,
        outcomeState: "partial",
        failureStage: "verification",
      }),
    }));
    expect(input.pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_1",
      path: "/v1/messages (stream)",
      finishReason: "stop",
      tokensIn: 10,
      tokensOut: 5,
      completionGateApplied: true,
      missingMustRequirements: 1,
      requestForensicsSummary: "summary",
      cacheStrategy: "anthropic_explicit",
      prefixFingerprint: "fingerprint",
      cacheShapeStablePrefixHash: "stable-prefix",
      cacheShapeToolSchemaHash: "tool-schema",
      cacheShapeProviderOptionsHash: "provider-options",
      cacheShapePromptTokens: 10,
      cacheShapeCachedTokens: 3,
      cacheShapeCacheCreationTokens: 0,
      cacheShapeHitPct: 30,
      cacheShapeOutcome: "hit",
    }));
  });

  it("creates route telemetry input with session-scoped event and scoped persistence callbacks", () => {
    const recordSessionEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const input = createClaudeStreamTelemetryInput({
      ...baseInput({
        recordSessionEvent: undefined as never,
        persistDecisionTelemetry: undefined as never,
      }),
      recordSessionEvent,
      persistDecisionTelemetry,
    });

    input.recordSessionEvent({
      eventKind: "kind",
      component: "component",
      detail: "detail",
    });
    input.persistDecisionTelemetry({
      usage: input.usage,
      latencyMs: 42,
      finishReason: "stop",
      tokensSavedByReduction: 5,
      escalated: false,
      snapshot: {} as never,
      trajectory: {
        toolSequence: ["Read"],
        verificationSteps: [],
      },
    });

    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "kind",
      "component",
      "detail",
      "req_1",
    );
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      latencyMs: 42,
      finishReason: "stop",
      tokensSavedByReduction: 5,
      escalated: false,
    }));
  });
});
