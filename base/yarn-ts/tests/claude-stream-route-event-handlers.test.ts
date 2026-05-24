import { describe, expect, it, vi } from "vitest";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";
import {
  buildClaudeStreamRouteGovernanceOptions,
  createClaudeStreamRouteEventHandlers,
  type ClaudeStreamRouteEventHandlerInput,
} from "../src/streaming/claude-stream-route-event-handlers.js";

function makeInput(
  overrides: Partial<ClaudeStreamRouteEventHandlerInput> = {},
): ClaudeStreamRouteEventHandlerInput {
  const streamState = new ClaudeStreamState();
  return {
    streamState,
    adapter: { family: "openai" } as ClaudeStreamRouteEventHandlerInput["adapter"],
    requestId: "req-1",
    clientKind: "claude-code",
    debugProtocol: false,
    strictGovernance: false,
    recentToolNames: ["Read"],
    taskCue: { kind: "implementation" },
    clientPlanModeRequested: false,
    pathContext: { projectRoot: "/repo", shellCwd: "/repo/subdir" },
    enforcePathRoot: true,
    blockBashPathDrift: true,
    pathSandboxEnabled: true,
    artifactShadows: [],
    normalizedMessageCount: 2,
    session: {
      gitInspectionBlockCount: 1,
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: false,
      artifactEditTurns: new Map(),
      record: {
        requestCount: 7,
        metadata: {
          plan_content_shadow: { phase: "build" },
        },
      },
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
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    sendSse: vi.fn(() => true),
    scrubAndFlushTextBlock: vi.fn(),
    isWriteCapableToolName: vi.fn(() => false),
    shouldRestrictDiscoveryForPlanWork: vi.fn(() => true),
    deserializePlanShadow: vi.fn(() => ({ phase: "build" }) as never),
    buildPathSandboxPolicy: vi.fn((root: string) => ({ root }) as never),
    updateDiffAccumulator: vi.fn(),
    maybeUpdateTaskLedgerFromToolCall: vi.fn(),
    emitPlanWriteAuditEvent: vi.fn(),
    maybeLogEnvelopeUnwrapSample: vi.fn(),
    recordUpperHarnessDecision: vi.fn(),
    incrementStrictGovernanceRewrites: vi.fn(),
    recordRedirectedDiscovery: vi.fn(),
    getTopLevelDirs: vi.fn(async () => ["src"]),
    applyDiscoveryGuardrail: vi.fn((calls) => ({
      calls,
      blockedCount: 0,
      collapsedCount: 0,
      redirectedCount: 0,
      blockedDetails: [],
    })),
    buildBlockedDiscoveryRecovery: vi.fn(async () => ({
      text: "",
      entryCount: 0,
      recoveryMode: "top_level_snapshot",
    })),
    ...overrides,
  };
}

describe("Claude stream route event handlers", () => {
  it("builds governance options from route state", () => {
    const input = makeInput();
    input.streamState.startToolInput("tool-1", "Read");

    const options = buildClaudeStreamRouteGovernanceOptions(input);

    expect(options).toMatchObject({
      projectRoot: "/repo",
      shellCwd: "/repo/subdir",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      strictBashBlock: false,
      blockWriteCapableTools: false,
      clientKind: "claude-code",
      sessionGitInspectionBlockCount: 1,
      restrictDiscoveryForPlanWork: true,
      blockBroadVerificationForGreen: true,
      blockVerificationForFailure: false,
      currentTurnIndex: 4,
    });
    expect(input.deserializePlanShadow).toHaveBeenCalledWith({ phase: "build" });
    expect(input.buildPathSandboxPolicy).toHaveBeenCalledWith("/repo");

    options.onEditTurn?.("/repo/app.py", 4);
    expect(input.session.artifactEditTurns.get("/repo/app.py")).toBe(4);
  });

  it("uses explicit discovery and plan-mode decisions when present", () => {
    const input = makeInput({
      strictGovernance: false,
      clientPlanModeRequested: true,
      sensemakingRestrictDiscovery: false,
      pathSandboxEnabled: false,
    });

    const options = buildClaudeStreamRouteGovernanceOptions(input);

    expect(options.blockWriteCapableTools).toBe(true);
    expect(options.restrictDiscoveryForPlanWork).toBe(false);
    expect(options.pathSandboxPolicy).toBeNull();
    expect(input.shouldRestrictDiscoveryForPlanWork).not.toHaveBeenCalled();
  });

  it("forwards local events to the shared Claude local event handler", async () => {
    const sendSse = vi.fn(() => true);
    const scrubAndFlushTextBlock = vi.fn();
    const input = makeInput({ sendSse, scrubAndFlushTextBlock });
    const handlers = createClaudeStreamRouteEventHandlers(input);

    const handled = await handlers.handleLocalEvent({
      type: "text_delta",
      text: "hello",
    });

    expect(handled).toBe(true);
    expect(input.streamState.drainText()).toBe("hello");
    expect(scrubAndFlushTextBlock).not.toHaveBeenCalled();
  });
});
