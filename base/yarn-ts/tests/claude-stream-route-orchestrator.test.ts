import { describe, expect, it, vi } from "vitest";

import { runClaudeStreamRoute } from "../src/streaming/claude-stream-route-orchestrator.js";
import type { StreamTokenUsage } from "../src/streaming/openai-stream-finalizer.js";

const usage: StreamTokenUsage = {
  inputTokens: 7,
  outputTokens: 11,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

async function* parts(...items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

function reductions() {
  return {
    toolResultReduction: {
      getPerRequestDelta: () => 0,
      getPerRequestGuidedTruncationDelta: () => 0,
      getPerRequestTaskPrunedDelta: () => 0,
      getLastRecallDecision: () => null,
      getVerificationTracker: () => ({
        getState: () => ({
          round: 0,
          findings: [],
          stalled: false,
        }),
      }),
    },
    validationNormalization: {
      getPerRequestDelta: () => 0,
    },
  };
}

describe("runClaudeStreamRoute", () => {
  it("starts, runs, completes, and records telemetry for a Claude stream route", async () => {
    const writeHead = vi.fn();
    const sendSse = vi.fn(() => true);
    const endStream = vi.fn();
    const heartbeatStop = vi.fn();
    const admissionRelease = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const pushDiagnostic = vi.fn();
    const session = {
      skipToolIdStabilization: false,
      history: [],
      record: {
        requestCount: 1,
        sessionKey: "session_1",
      },
      taskCapabilities: null,
      taskLedger: null,
      gitInspectionBlockCount: 0,
      blockBroadVerificationUntilEdit: false,
      blockFailingVerificationUntilEdit: false,
      artifactEditTurns: new Map(),
    };

    const result = await runClaudeStreamRoute({
      start: {
        scope: {
          sessionKey: "session_1",
          userId: "user_1",
          orgId: "org_1",
          requestId: "trace_1",
        },
        recordSessionEvent: vi.fn(),
        raw: {
          destroyed: false,
          write: vi.fn(),
          writeHead,
        } as never,
        headers: { "content-type": "text/event-stream" },
        heartbeatIntervalMs: 15_000,
        longWaitEventMs: 45_000,
        startHeartbeat: vi.fn(() => ({ stop: heartbeatStop })),
        createMessageId: () => "msg_1",
        sendSse,
        streamText: vi.fn(() => ({
          fullStream: parts({ type: "text-delta", text: "hello" }, { type: "finish", finishReason: "stop" }),
          totalUsage: Promise.resolve({}),
          text: Promise.resolve("hello"),
        })),
        request: {
          requestId: "trace_1",
          model: "model",
          messages: [{ role: "user", content: "hi" }],
          adapter: { family: "openai", supportsThinking: true },
          abortSignal: new AbortController().signal,
          orchestrationMaxOutputTokens: 128,
          tools: [{ name: "Edit" }],
          toolChoice: "auto",
          providerOptions: { anthropic: { cache_control: "ephemeral" } },
          clampMaxOutputTokens: (tokens) => tokens,
          logger: { warn: vi.fn() },
        },
        components: {
          tierConfig: { baseUrl: "https://api.anthropic.com", backendModel: "claude-test" },
          resolvedModelId: "claude-test",
          tools: [{ name: "Edit" }],
          computePrefixFingerprint: vi.fn(() => "prefix_1"),
        },
      },
      pipeline: {
        eventHandlers: {
          adapter: { family: "openai", supportsThinking: true } as never,
          requestId: "trace_1",
          clientKind: "claude-code",
          debugProtocol: false,
          strictGovernance: false,
          recentToolNames: [],
          taskCue: null,
          clientPlanModeRequested: false,
          pathContext: {},
          enforcePathRoot: false,
          blockBashPathDrift: false,
          pathSandboxEnabled: false,
          artifactShadows: [],
          normalizedMessageCount: 1,
          session,
          stats: {} as never,
          logger: { warn: vi.fn(), error: vi.fn() } as never,
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
          recordRedirectedDiscovery: vi.fn(),
          getTopLevelDirs: vi.fn(async () => []),
          applyDiscoveryGuardrail: vi.fn() as never,
          buildBlockedDiscoveryRecovery: vi.fn() as never,
        },
        lifecycle: {
          session,
          abortSignal: new AbortController().signal,
          hardTimeout: setTimeout(() => undefined, 60_000),
          admissionRelease,
          span: { setStatus: vi.fn(), end: vi.fn() },
          circuitBreakers: { recordFailure: vi.fn(), recordSuccess: vi.fn() },
          logger: { error: vi.fn() },
          extractUpstreamErrorDiagnostics: vi.fn(),
          recordSessionEvent: vi.fn(),
        },
        afterEvents: {
          adapter: { family: "openai" },
          stats: { qwenParserMismatchSuspectCount: 0 },
          logger: { warn: vi.fn() },
          recordBlockedDiscovery: vi.fn(),
          getBlockedDiscoveryCount: vi.fn(() => 0),
          recordSessionEvent: vi.fn(),
        },
      },
      completion: {
        finalizer: {
          session,
          sessionKey: "session_1",
          userId: "user_1",
          orgId: "org_1",
          requestId: "req_1",
          readUsage: () => usage,
          finalizeRequestForensics: () => ({ summary: "stable-prefix" }),
          handlerInput: {
            session,
            pendingRequestId: "trace_1",
            historyRequestId: "req_1",
            sessionKey: "session_1",
            userId: "user_1",
            orgId: "org_1",
            checklist: null,
            traceRootPrompt: "",
            latestUserPrompt: "",
            verification: {},
            recentToolNames: [],
            responseStyleMode: "default",
            applyMarkdownGuardrail: (text) => text,
            finalizeCompletionText: async (input) => ({
              finalText: input.assistantText,
              applied: false,
              missingMust: 0,
              missingShould: 0,
              blockedByVerification: false,
              criticBlocked: false,
            }),
            finalizePostStreamText: (input) => ({
              finalText: input.assistantText,
              applied: false,
              missingMust: 0,
              missingShould: 0,
              blockedByVerification: false,
              criticBlocked: false,
            }),
          },
          endStream,
          recordSessionEvent: vi.fn(),
        },
        telemetry: {
          scope: {
            sessionKey: "session_1",
            userId: "user_1",
            orgId: "org_1",
            requestId: "req_1",
          },
          startedAtMs: Date.now(),
          resolvedModelId: "claude-test",
          clientRequestedModel: "claude-test",
          reductions: reductions(),
          reducedToolResults: 0,
          orchestration: { decisionPath: "direct", escalated: false },
          policyMatchedRules: [],
          normalizedMessages: [{ role: "user", content: "hi" }],
          inferVerificationSteps: (toolNames) => toolNames,
          toolDefinitionCount: 1,
          artifactToolInjected: false,
          knowledgeToolInjected: false,
          countMessageRoles: () => ({
            systemMessageCount: 0,
            userMessageCount: 1,
            toolMessageCount: 0,
            totalInputChars: 2,
          }),
          pushDiagnostic,
          recordSessionEvent: vi.fn(),
          persistDecisionTelemetry,
        },
      },
    });

    expect(result.stopReason).toBe("end_turn");
    expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "text/event-stream" });
    expect(sendSse).toHaveBeenCalledWith("message_start", expect.any(Object));
    expect(endStream).toHaveBeenCalledOnce();
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(admissionRelease).toHaveBeenCalledOnce();
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      usage,
      finishReason: "end_turn",
    }));
    expect(pushDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      requestForensicsSummary: "stable-prefix",
      cacheShapeMessageCount: 1,
      cacheStrategy: "anthropic_explicit",
      prefixFingerprint: "prefix_1",
    }));
  });
});
