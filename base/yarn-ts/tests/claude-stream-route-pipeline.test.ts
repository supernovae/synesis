import { describe, expect, it, vi } from "vitest";

import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";
import { runClaudeStreamRoutePipeline } from "../src/streaming/claude-stream-route-pipeline.js";

async function* parts(...items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

describe("runClaudeStreamRoutePipeline", () => {
  it("assembles route handlers, after-events, lifecycle, and streams to completion", async () => {
    const streamState = new ClaudeStreamState();
    const admissionRelease = vi.fn();
    const recordSessionEvent = vi.fn();
    const recordSuccess = vi.fn();
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const hardTimeout = setTimeout(() => undefined, 60_000);

    const result = await runClaudeStreamRoutePipeline({
      streamParts: parts(
        { type: "text-delta", text: "hello" },
        { type: "finish", finishReason: "stop" },
      ),
      eventHandlersInput: {
        streamState,
        adapter: { family: "openai", supportsThinking: true } as never,
        requestId: "req_1",
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
        session: {
          gitInspectionBlockCount: 0,
          blockBroadVerificationUntilEdit: false,
          blockFailingVerificationUntilEdit: false,
          artifactEditTurns: new Map(),
          record: { requestCount: 1, metadata: {} },
        },
        acceptedGuardrailCalls: [],
        blockedDiscoveryDetails: [],
        discovery: {
          recoveryPreviewEntries: 0,
          recoveryMode: null,
          blockedBroadDiscovery: 0,
          collapsedBroadDiscovery: 0,
        },
        toolSequence: [],
        stats: {} as never,
        logger: { warn: vi.fn(), error: vi.fn() } as never,
        sendSse: vi.fn(() => true),
        scrubAndFlushTextBlock: vi.fn(),
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
      lifecycleInput: {
        requestId: "req_1",
        model: "claude-test",
        orgId: "org_1",
        session: { skipToolIdStabilization: false },
        abortSignal: new AbortController().signal,
        hardTimeout,
        admissionRelease,
        streamState,
        span,
        circuitBreakers: {
          recordFailure: vi.fn(),
          recordSuccess,
        },
        logger: { error: vi.fn() },
        extractUpstreamErrorDiagnostics: vi.fn(),
        sendSse: vi.fn(() => true),
        recordSessionEvent,
      },
      afterEventsInput: {
        adapter: { family: "openai" },
        localLikeBaseUrl: false,
        requestId: "req_1",
        resolvedModelId: "claude-test",
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        streamState,
        discovery: {
          recoveryPreviewEntries: 0,
          recoveryMode: null,
          blockedBroadDiscovery: 0,
          collapsedBroadDiscovery: 0,
        },
        blockedDetails: [],
        stats: { qwenParserMismatchSuspectCount: 0 },
        logger: { warn: vi.fn() },
        recordBlockedDiscovery: vi.fn(),
        getBlockedDiscoveryCount: vi.fn(() => 0),
        recordSessionEvent: vi.fn(),
      },
    });

    expect(result).toEqual({
      toolRepairs: 0,
      validationFailures: 0,
      stopReason: "end_turn",
    });
    expect(admissionRelease).toHaveBeenCalledOnce();
    expect(recordSuccess).toHaveBeenCalledWith("claude-test", "org_1");
    expect(span.setStatus).toHaveBeenCalledWith("ok");
    expect(span.end).toHaveBeenCalledOnce();
    expect(streamState.drainText()).toBe("hello");
  });
});
