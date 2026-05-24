import { describe, expect, it, vi } from "vitest";
import type { ToolArgHardeningStats } from "../src/governance/tool-call-observability.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";
import { processClaudeNonStreamProviderResult } from "../src/streaming/claude-nonstream-postprocess.js";

function stats(): ToolArgHardeningStats {
  return {
    normalizedPathCount: 0,
    projectRootConstrainedCount: 0,
    envelopeUnwrappedCount: 0,
    envelopeUnwrappedArgsObjectCount: 0,
    envelopeUnwrappedArgsJsonStringCount: 0,
    envelopeUnwrappedArgumentsObjectCount: 0,
    envelopeUnwrappedArgumentsJsonStringCount: 0,
    envelopeUnwrappedInputObjectCount: 0,
    envelopeUnwrappedInputJsonStringCount: 0,
    blockedBashPathDriftCount: 0,
    blockedUnsafeShellCount: 0,
    blockedWriteCapableToolCount: 0,
    remappedArgsCount: 0,
    repairedWriteContentCount: 0,
    repairedWriteCount: 0,
    repairedBashCount: 0,
    validationFailedCount: 0,
    qwenParserMismatchSuspectCount: 0,
  };
}

describe("processClaudeNonStreamProviderResult", () => {
  it("processes provider result through finalization, telemetry, and response assembly", async () => {
    const session = {
      history: [],
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: true,
      gitInspectionBlockCount: 0,
      artifactEditTurns: new Map<string, number>(),
      record: {
        requestCount: 1,
        metadata: {},
      },
    };
    const persistDecisionTelemetry = vi.fn();
    const pushDiagnostic = vi.fn();

    const processed = await processClaudeNonStreamProviderResult({
      result: {
        text: "done",
        reasoning: "thinking",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        },
        toolCalls: [],
      },
      serverWebSearchEvents: [],
      readUsage: (usage) => usage as never,
      toolCallInput: {
        adapter: { family: "test", supportsThinking: false } as ModelAdapter,
        requestId: "req_1",
        clientKind: "claude-code",
        strictGovernance: false,
        recentToolNames: [],
        pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
        enforcePathRoot: false,
        blockBashPathDrift: false,
        pathSandboxEnabled: false,
        planModeRequested: false,
        session,
        taskCue: null,
        normalizedMessageCount: 1,
        stats: stats(),
        logger: { warn: vi.fn() },
        isWriteCapableToolName: () => false,
        shouldRestrictDiscoveryForPlanWork: () => false,
        deserializePlanShadow: () => null,
        buildPathSandboxPolicy: vi.fn() as never,
        updateDiffAccumulator: vi.fn(),
        maybeUpdateTaskLedgerFromToolCall: vi.fn(),
        emitPlanWriteAuditEvent: vi.fn(),
        maybeLogEnvelopeUnwrapSample: vi.fn(),
        recordUpperHarnessDecision: vi.fn(),
        incrementStrictGovernanceRewrites: vi.fn(),
      },
      discoveryInput: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        resolvedModelId: "claude-test",
        projectRoot: "/repo",
        getTopLevelDirs: vi.fn(async () => []),
        applyDiscoveryGuardrail: (calls) => ({
          calls,
          blockedCount: 0,
          redirectedCount: 0,
          collapsedCount: 0,
          blockedDetails: [],
          redirectedDetails: [],
        }),
        buildBlockedDiscoveryRecovery: vi.fn(),
        recordBlockedDiscovery: vi.fn(),
        getBlockedDiscoveryCount: vi.fn(() => 0),
        recordSessionEvent: vi.fn(),
      },
      finalizerInput: {
        session,
        requestId: "req_1",
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        checklist: null,
        traceRootPrompt: "",
        latestUserPrompt: "",
        verification: null,
        recentToolNames: [],
        responseStyleMode: "default",
        applyMarkdownGuardrail: (text) => `${text}!`,
        finalizeCompletionText: vi.fn(async ({ assistantText }) => ({
          finalText: assistantText,
          applied: false,
          missingMust: 0,
          missingShould: 0,
          blockedByVerification: false,
          criticBlocked: false,
        })),
        recordSessionEvent: vi.fn(),
      },
      telemetryInput: {
        requestId: "req_1",
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        startedAtMs: Date.now() - 5,
        resolvedModelId: "claude-test",
        clientRequestedModel: "claude-test",
        reductions: {
          toolResultReduction: {
            getPerRequestDelta: () => 0,
            getPerRequestGuidedTruncationDelta: () => 0,
            getPerRequestTaskPrunedDelta: () => 0,
            getLastRecallDecision: () => null as never,
            getVerificationTracker: () => ({ getState: () => ({ round: 0, findings: [], stalled: false }) as never }),
          },
          validationNormalization: { getPerRequestDelta: () => 0 },
        },
        reducedToolResults: 0,
        orchestration: { decisionPath: "direct", escalated: false } as never,
        policyMatchedRules: [],
        normalizedMessages: [{ role: "user", content: "hello" }],
        inferVerificationSteps: () => [],
        toolDefinitionCount: 0,
        artifactToolInjected: false,
        knowledgeToolInjected: false,
        recordSessionEvent: vi.fn(),
        persistDecisionTelemetry,
        countMessageRoles: () => ({
          systemMessageCount: 0,
          userMessageCount: 1,
          toolMessageCount: 0,
          totalInputChars: 5,
        }),
        pushDiagnostic,
      },
    });

    expect(processed.stopReason).toBe("end_turn");
    expect(processed.finalText).toBe("done!");
    expect(processed.usage.inputTokens).toBe(12);
    expect(processed.content).toEqual([
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "done!" },
    ]);
    expect(session.history).toEqual([{ role: "assistant", content: "done!" }]);
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "end_turn",
      usage: expect.objectContaining({ inputTokens: 12 }),
    }));
    expect(pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/messages",
      tokensIn: 12,
      tokensOut: 3,
    }));
  });
});
