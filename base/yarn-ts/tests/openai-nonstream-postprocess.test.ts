import { describe, expect, it, vi } from "vitest";
import {
  createOpenAINonStreamPostProviderInput,
  processOpenAINonStreamProviderResult,
} from "../src/pipeline/openai-nonstream-postprocess.js";

describe("processOpenAINonStreamProviderResult", () => {
  it("composes non-stream post-provider handling into an OpenAI response", async () => {
    const session = {
      history: [],
      blockBroadVerificationUntilEdit: false,
      blockFailingVerificationUntilEdit: false,
      gitInspectionBlockCount: 0,
      artifactEditTurns: new Map<string, number>(),
      taskCapabilities: null,
      taskLedger: null,
      record: {
        requestCount: 1,
        sessionKey: "session_1",
        metadata: {},
      },
    };
    const persistDecisionTelemetry = vi.fn();
    const pushDiagnostic = vi.fn();

    const processed = await processOpenAINonStreamProviderResult({
      result: {
        text: "done",
        reasoning: "thinking",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        },
        toolCalls: [],
      },
      responseId: "chatcmpl_1",
      responseModel: "openai-test",
      readUsage: (usage) => usage as never,
      toolCallInput: {
        artifactToolName: "artifact",
        adapter: {
          family: "openai",
          normalizeToolName: (name: string) => name,
          restoreToolNameForClient: (name: string) => name,
          normalizeToolCallInput: (name: string, input: Record<string, unknown>) => ({ toolName: name, input, repaired: false }),
        } as never,
        effectiveTools: [],
        clientKind: "opencode",
        recentToolNames: [],
        pathContext: {},
        enforcePathRoot: false,
        blockBashPathDrift: false,
        strictGovernance: false,
        planModeRequested: false,
        session,
        shouldRestrictDiscoveryForPlanWork: () => false,
        taskCue: undefined,
        artifactShadows: new Map(),
        normalizedMessageCount: 1,
        pathSandboxEnabled: false,
        deserializePlanShadow: () => null,
        buildPathSandboxPolicy: () => ({}) as never,
        isWriteCapableToolName: () => false,
        stats: {
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
        },
        strictGovernanceStats: { strictGovernanceRewrites: 0 },
        logger: { warn: vi.fn(), info: vi.fn() },
        requestId: "req_1",
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        recordUpperHarnessDecision: vi.fn(),
        updateDiffAccumulator: vi.fn(),
        maybeUpdateTaskLedgerFromToolCall: vi.fn(),
        emitPlanWriteAuditEvent: vi.fn(),
        maybeLogEnvelopeUnwrapSample: vi.fn(),
      },
      topLevelDirs: [],
      applyDiscoveryGuardrail: (calls) => ({
        calls,
        blockedCount: 0,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [],
        redirectedDetails: [],
      }),
      discoveryInput: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        resolvedModelId: "openai-test",
        projectRoot: "/repo",
        buildBlockedDiscoveryRecovery: vi.fn(),
        recordBlockedDiscovery: vi.fn(),
        getBlockedDiscoveryCount: vi.fn(() => 0),
        recordSessionEvent: vi.fn(),
      },
      collapseInput: {
        enabled: false,
        rewriteNonStream: false,
        collapseHeader: undefined,
        workspaceRoot: null,
        shellAllowlistEnv: "",
        logger: { info: vi.fn() },
        requestId: "req_1",
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
        resolvedModelId: "openai-test",
        clientRequestedModel: "openai-test",
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
        optimizationLedger: {
          setUpstreamCachedTokens: vi.fn(),
          recordFinal: vi.fn(),
          finalize: vi.fn(() => ({})),
          toLogRecord: vi.fn(() => ({})),
        },
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
        logOptimizationLedger: vi.fn(),
      },
      responseInput: {
        effectiveTools: [],
        clientKind: "opencode",
      },
    });

    expect(processed.finishReason).toBe("stop");
    expect(processed.finalText).toBe("done!");
    expect(processed.body.choices[0]?.message).toEqual({
      role: "assistant",
      content: "done!",
      reasoning_content: "thinking",
    });
    expect(session.history).toEqual([{ role: "assistant", content: "done!" }]);
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      usage: expect.objectContaining({ inputTokens: 5 }),
    }));
    expect(pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/chat/completions",
      tokensIn: 5,
    }));
  });
});

describe("createOpenAINonStreamPostProviderInput", () => {
  it("binds route scope into post-provider callbacks", () => {
    const recordEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const input = createOpenAINonStreamPostProviderInput({
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        recordEvent,
        persistDecisionTelemetry,
      },
      responseModel: "openai-test",
      readUsage: (usage) => usage as never,
      toolCallInput: {
        requestId: "old",
        sessionKey: "old",
        userId: "old",
        orgId: "old",
      } as never,
      applyDiscoveryGuardrail: (calls) => ({
        calls,
        blockedCount: 0,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [],
        redirectedDetails: [],
      }),
      discoveryInput: {
        projectRoot: "/repo",
      } as never,
      collapseInput: {
        enabled: false,
        rewriteNonStream: false,
        collapseHeader: undefined,
        workspaceRoot: null,
        shellAllowlistEnv: "",
        logger: { info: vi.fn() },
        requestId: "req_1",
      },
      finalizerInput: {} as never,
      telemetryInput: {
        clientRequestedModel: "openai-test",
        escalated: true,
      } as never,
      responseInput: {
        effectiveTools: [],
        clientKind: "opencode",
      },
    });

    expect(input.responseId).toBe("req_1");
    expect(input.toolCallInput).toMatchObject({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
    });

    input.discoveryInput.recordSessionEvent(
      "ignored",
      "ignored",
      "ignored",
      "event",
      "component",
      "detail",
      "ignored",
      { ok: true },
    );
    input.telemetryInput.persistDecisionTelemetry({
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      latencyMs: 5,
      finishReason: "stop",
      tokensSavedByReduction: 0,
      snapshot: {} as never,
      trajectory: { toolSequence: [] },
      optimizationLedger: { prefix_hash: "abc" },
    });

    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "event",
      component: "component",
      detail: "detail",
      metadataJson: { ok: true },
    });
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      escalated: true,
      optimizationLedger: { prefix_hash: "abc" },
    }));
  });
});
