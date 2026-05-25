import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRouteInput } from "../src/streaming/claude-stream-route-facade-input.js";

describe("buildClaudeStreamRouteInput", () => {
  it("composes start, event, pipeline support, and completion builders", () => {
    const abortController = new AbortController();
    const hardTimeout = setTimeout(() => undefined, 60_000);
    const admissionRelease = vi.fn();
    const span = { setStatus: vi.fn(), end: vi.fn() };
    const streamScope = {
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "trace-1",
    };
    const responseScope = {
      ...streamScope,
      requestId: "req-1",
    };

    const input = buildClaudeStreamRouteInput({
      runtime: {
        streamSpan: span,
        startedAtMs: 123,
        streamScope,
        responseScope,
        recordStreamEvent: vi.fn(),
        admissionRelease,
        streamForensics: {},
        streamToolSideEffects: {
          updateDiffAccumulator: vi.fn(),
          maybeUpdateTaskLedgerFromToolCall: vi.fn(),
          emitPlanWriteAuditEvent: vi.fn(),
          maybeLogEnvelopeUnwrapSample: vi.fn(),
          recordUpperHarnessDecision: vi.fn(),
          incrementStrictGovernanceRewrites: vi.fn(),
        },
        streamAbortRuntime: {
          abortController,
          hardTimeout,
          hardTimeoutMs: 60_000,
        },
      },
      start: {
        recordSessionEvent: vi.fn(),
        transport: {
          raw: { destroyed: false, write: vi.fn(), writeHead: vi.fn() } as never,
          headers: { "content-type": "text/event-stream" },
          heartbeatIntervalMs: 15_000,
          longWaitEventMs: 45_000,
          startHeartbeat: vi.fn(),
          createMessageId: () => "msg-1",
          sendSse: vi.fn(),
          streamText: vi.fn(),
        },
        provider: {
          requestId: "trace-1",
          model: "model",
          messages: [{ role: "user", content: "hi" }],
          adapter: { family: "anthropic", supportsThinking: true },
          orchestrationMaxOutputTokens: 256,
          clampMaxOutputTokens: (tokens) => tokens,
          logger: { warn: vi.fn() },
        },
        components: {
          resolvedModelId: "claude-test",
          tools: [],
          computePrefixFingerprint: () => "prefix-1",
        },
      },
      eventHandlers: {
        base: {
          adapter: { family: "anthropic", supportsThinking: true } as never,
          requestId: "trace-1",
          clientKind: "claude-code",
          debugProtocol: false,
          strictGovernance: false,
          taskCue: null,
          clientPlanModeRequested: false,
          pathContext: {},
          enforcePathRoot: false,
          blockBashPathDrift: false,
          pathSandboxEnabled: false,
          artifactShadows: [],
          session: {
            gitInspectionBlockCount: 0,
            blockBroadVerificationUntilEdit: false,
            blockFailingVerificationUntilEdit: false,
            artifactEditTurns: new Map(),
            record: { requestCount: 1, metadata: {} },
          },
          stats: {} as never,
          logger: { warn: vi.fn(), error: vi.fn() } as never,
          isWriteCapableToolName: () => false,
          shouldRestrictDiscoveryForPlanWork: () => false,
          deserializePlanShadow: () => null,
          buildPathSandboxPolicy: vi.fn() as never,
          getTopLevelDirs: vi.fn(async () => []),
          applyDiscoveryGuardrail: vi.fn() as never,
        },
        toolSideEffects: {
          updateDiffAccumulator: vi.fn(),
          maybeUpdateTaskLedgerFromToolCall: vi.fn(),
          emitPlanWriteAuditEvent: vi.fn(),
          maybeLogEnvelopeUnwrapSample: vi.fn(),
          recordUpperHarnessDecision: vi.fn(),
          incrementStrictGovernanceRewrites: vi.fn(),
        },
        recentCalls: [{ toolName: "Read" }],
        normalizedMessages: [{ role: "user" }],
        route: {
          sessionKey: "session-1",
          resolvedModelId: "claude-test",
        },
        recordBlockedDiscovery: vi.fn(),
        buildBlockedDiscoveryRecoverySnapshot: vi.fn(async () => ({
          text: "",
          entryCount: 0,
          recoveryMode: "no_project_root" as const,
        })),
      },
      pipelineSupport: {
        lifecycle: {
          session: {},
          circuitBreakers: {},
          logger: {},
          extractUpstreamErrorDiagnostics: vi.fn(),
          recordSessionEvent: vi.fn(),
        } as never,
        afterEvents: {} as never,
      },
      completion: {
        scope: {
          pendingRequestId: "trace-1",
          historyRequestId: "req-1",
          sessionKey: "session-1",
          userId: "user-1",
          orgId: "org-1",
        },
        metadata: {
          source: {},
          getString: () => "",
        },
        recentMessages: [],
        extractRecentToolNames: () => [],
        checklist: { must: [], should: [] },
        finalizer: {
          session: {},
          readUsage: vi.fn(),
          finalizeRequestForensics: vi.fn(),
          handlerInput: {
            session: {},
            verification: {},
            responseStyleMode: "default",
            applyMarkdownGuardrail: (text: string) => text,
            finalizeCompletionText: vi.fn(),
            finalizePostStreamText: vi.fn(),
          },
          endStream: vi.fn(),
          recordSessionEvent: vi.fn(),
        } as never,
        telemetry: {
          clientRequestedModel: "claude-test",
          reductions: {},
          reducedToolResults: 0,
          orchestration: {},
          policyMatchedRules: [],
          normalizedMessages: [],
          inferVerificationSteps: vi.fn(),
          toolDefinitionCount: 0,
          artifactToolInjected: false,
          knowledgeToolInjected: false,
          countMessageRoles: vi.fn(),
          pushDiagnostic: vi.fn(),
          recordSessionEvent: vi.fn(),
          persistDecisionTelemetry: vi.fn(),
        } as never,
      },
    });

    expect(input.start.scope).toBe(streamScope);
    expect(input.start.request.abortSignal).toBe(abortController.signal);
    expect(input.pipeline.eventHandlers.recentToolNames).toEqual(["Read"]);
    expect(input.pipeline.lifecycle.admissionRelease).toBe(admissionRelease);
    expect(input.pipeline.lifecycle.span).toBe(span);
    expect(input.completion.finalizer).toMatchObject(responseScope);
    expect(input.completion.telemetry.scope).toBe(responseScope);
    expect(input.completion.telemetry.resolvedModelId).toBe("claude-test");

    clearTimeout(hardTimeout);
  });
});
