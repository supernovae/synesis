import { describe, expect, it, vi } from "vitest";
import type { ToolArgHardeningStats } from "../src/governance/tool-call-observability.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";
import {
  buildOpenAIStreamRouteGovernanceOptions,
  createOpenAIStreamRouteEventHandlers,
  type OpenAIStreamRouteEventHandlerInput,
} from "../src/streaming/openai-stream-route-event-handlers.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";
import { createOpenAIStreamToolCallAccumulator } from "../src/streaming/openai-stream-tool-call-handler.js";

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

function inputHarness(
  overrides: Partial<OpenAIStreamRouteEventHandlerInput> = {},
) {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    write: (data: string) => {
      writes.push(data);
    },
  } as NodeJS.WritableStream & { destroyed?: boolean };
  const streamState = new OpenAIStreamState();
  const writer = new OpenAIStreamResponseWriter({
    raw,
    requestId: "chatcmpl_test",
    model: "model-a",
  });
  const adapter: ModelAdapter = {
    family: "test",
    supportsThinking: false,
  };
  const session = {
    gitInspectionBlockCount: 2,
    blockBroadVerificationUntilEdit: true,
    blockFailingVerificationUntilEdit: true,
    artifactEditTurns: new Map<string, number>(),
    record: {
      requestCount: 4,
      metadata: {
        plan_content_shadow: { path: ".claude/plans/test.md" },
      },
    },
  };
  const input: OpenAIStreamRouteEventHandlerInput = {
    streamState,
    writer,
    adapter,
    requestId: "req_1",
    resolvedModelId: "model-a",
    clientKind: "opencode",
    effectiveTools: [],
    debugProtocol: false,
    strictGovernance: false,
    recentToolNames: [],
    taskCue: "build tests",
    clientPlanModeRequested: true,
    sensemakingRestrictDiscovery: undefined,
    pathContext: {
      projectRoot: "/repo",
      shellCwd: "/repo/subdir",
    },
    enforcePathRoot: true,
    blockBashPathDrift: true,
    pathSandboxEnabled: true,
    artifactShadows: new Map(),
    normalizedMessageCount: 5,
    session,
    acceptedGuardrailCalls: [],
    blockedDiscoveryDetails: [],
    stats: stats(),
    logger: { warn: vi.fn(), debug: vi.fn() },
    accumulator: createOpenAIStreamToolCallAccumulator(),
    scrubAndFlushText: vi.fn((text: string) => writer.writeTextDelta(text)),
    isWriteCapableToolName: () => false,
    shouldRestrictDiscoveryForPlanWork: vi.fn(() => true),
    deserializePlanShadow: vi.fn(() => ({
      path: ".claude/plans/test.md",
      contentHash: "hash",
      contentLength: 10,
      status: "complete",
    }) as never),
    buildPathSandboxPolicy: vi.fn((projectRoot: string) => ({
      projectRoot,
      homeDir: "/home/test",
      allowedReadGlobs: [],
      allowedWriteGlobs: [],
      blockedGlobs: [],
    })),
    updateDiffAccumulator: vi.fn(),
    maybeUpdateTaskLedgerFromToolCall: vi.fn(),
    emitPlanWriteAuditEvent: vi.fn(),
    maybeLogEnvelopeUnwrapSample: vi.fn(),
    recordUpperHarnessDecision: vi.fn(),
    incrementStrictGovernanceRewrites: vi.fn(),
    recordRedirectedDiscovery: vi.fn(),
    getTopLevelDirs: vi.fn(async () => []),
    applyDiscoveryGuardrail: (calls) => ({
      calls,
      blockedCount: 0,
      redirectedCount: 0,
      collapsedCount: 0,
      blockedDetails: [],
    }),
    buildBlockedDiscoveryRecovery: vi.fn(async () => ({
      text: "recovery",
      entryCount: 1,
      recoveryMode: "top_level_snapshot",
    })),
    ...overrides,
  };
  return { input, writes, streamState, session };
}

describe("createOpenAIStreamRouteEventHandlers", () => {
  it("builds route governance options from stream and session state", () => {
    const { input, streamState, session } = inputHarness();
    streamState.startToolInput("tc1", "Bash");

    const options = buildOpenAIStreamRouteGovernanceOptions(input);

    expect(options).toMatchObject({
      projectRoot: "/repo",
      shellCwd: "/repo/subdir",
      enforcePathRoot: true,
      blockBashPathDrift: true,
      blockWriteCapableTools: true,
      sessionGitInspectionBlockCount: 2,
      restrictDiscoveryForPlanWork: true,
      blockBroadVerificationForGreen: true,
      blockVerificationForFailure: true,
      currentTurnIndex: 7,
    });
    expect(options.pathSandboxPolicy).toMatchObject({ projectRoot: "/repo" });
    options.onEditTurn?.("/repo/app.py", 8);
    expect(session.artifactEditTurns.get("/repo/app.py")).toBe(8);
  });

  it("lets sensemaking discovery decisions override task-cue heuristics", () => {
    const shouldRestrictDiscoveryForPlanWork = vi.fn(() => true);
    const { input } = inputHarness({
      sensemakingRestrictDiscovery: false,
      shouldRestrictDiscoveryForPlanWork,
    });

    const options = buildOpenAIStreamRouteGovernanceOptions(input);

    expect(options.restrictDiscoveryForPlanWork).toBe(false);
    expect(shouldRestrictDiscoveryForPlanWork).not.toHaveBeenCalled();
  });

  it("uses persisted workspace metadata when stream path context is missing", () => {
    const { input } = inputHarness({
      pathContext: {},
    });
    input.session.record.metadata.workspace_context_cwd = "/home/byron/src/test";
    input.session.record.metadata.workspace_context_project_root = "/home/byron/src/test";

    const options = buildOpenAIStreamRouteGovernanceOptions(input);

    expect(options.projectRoot).toBe("/home/byron/src/test");
    expect(options.shellCwd).toBe("/home/byron/src/test");
    expect(options.pathSandboxPolicy).toMatchObject({ projectRoot: "/home/byron/src/test" });
  });

  it("delegates text buffering through the low-level event handlers", () => {
    const { input, writes, streamState } = inputHarness();
    const handlers = createOpenAIStreamRouteEventHandlers(input);

    handlers.onTextDelta?.({ type: "text_delta", text: "hello" });
    handlers.onToolInputStart?.({
      type: "tool_input_start",
      toolCallId: "tc1",
      toolName: "Bash",
      input: undefined,
    });

    expect(input.scrubAndFlushText).toHaveBeenCalledWith("hello");
    expect(writes[0]).toContain("\"content\":\"hello\"");
    expect(streamState.findToolCall("tc1")).toMatchObject({
      id: "tc1",
      name: "Bash",
    });
  });
});
