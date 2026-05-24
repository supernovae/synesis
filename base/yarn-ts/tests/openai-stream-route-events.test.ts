import { describe, expect, it } from "vitest";
import { createOpenAIStreamRouteEventPipelineHandlers } from "../src/pipeline/openai-stream-route-events.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";

describe("createOpenAIStreamRouteEventPipelineHandlers", () => {
  it("wires route side-effect callbacks into OpenAI stream event handlers", async () => {
    const calls: string[] = [];
    const session = {
      gitInspectionBlockCount: 0,
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: true,
      artifactEditTurns: new Map<string, number>(),
      record: {
        requestCount: 3,
        metadata: {},
      },
    };
    const handlers = createOpenAIStreamRouteEventPipelineHandlers({
      scope: {
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-1",
      },
      streamState: new OpenAIStreamState(),
      writer: {
        writeTextDelta: () => undefined,
        writeToolCall: () => undefined,
        writeToolCallDelta: () => undefined,
        writeDone: () => undefined,
      } as never,
      adapter: {
        family: "openai",
        normalizeToolName: (name: string) => name,
        restoreToolNameForClient: (name: string) => name,
        normalizeToolCallInput: (name: string, input: Record<string, unknown>) => ({ toolName: name, input, repaired: false }),
      } as never,
      resolvedModelId: "model-1",
      clientKind: "opencode",
      effectiveTools: [],
      debugProtocol: false,
      strictGovernance: false,
      recentToolNames: [],
      taskCue: undefined,
      clientPlanModeRequested: false,
      pathContext: {},
      enforcePathRoot: false,
      blockBashPathDrift: false,
      pathSandboxEnabled: false,
      artifactShadows: [],
      normalizedMessageCount: 1,
      session,
      acceptedGuardrailCalls: [],
      blockedDiscoveryDetails: [],
      stats: {
        parseRepairCount: 0,
        invalidInputCount: 0,
        qwenParserMismatchSuspectCount: 0,
      } as never,
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined } as never,
      accumulator: {
        emittedToolCalls: [],
        toolRepairs: 0,
        validationFailures: 0,
        blockedBroadDiscovery: 0,
        collapsedBroadDiscovery: 0,
      } as never,
      scrubAndFlushText: () => undefined,
      isWriteCapableToolName: (name) => name === "Write",
      shouldRestrictDiscoveryForPlanWork: () => false,
      deserializePlanShadow: () => null,
      buildPathSandboxPolicy: () => ({ root: "/tmp" }) as never,
      sideEffects: {
        updateDiffAccumulator: () => calls.push("diff"),
        maybeUpdateTaskLedgerFromToolCall: () => calls.push("ledger"),
        emitPlanWriteAuditEvent: () => calls.push("audit"),
        maybeLogEnvelopeUnwrapSample: () => calls.push("unwrap"),
        recordUpperHarnessDecision: () => calls.push("upper"),
      },
      strictGovernanceStats: { strictGovernanceRewrites: 0 },
      recordBlockedDiscovery: () => calls.push("blocked"),
      getTopLevelDirs: async () => [],
      applyDiscoveryGuardrail: () => ({
        calls: [{ toolCallId: "call-1", toolName: "Write", input: { file_path: "a.txt", content: "x" } }],
        blocked: [],
        blockedCount: 0,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [],
      }) as never,
      buildBlockedDiscoveryRecovery: async () => ({ mode: "none" }) as never,
    });

    await handlers.onToolCall?.({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "Write",
      input: { file_path: "a.txt", content: "x" },
      created: 1,
    });

    expect(session.blockBroadVerificationUntilEdit).toBe(false);
    expect(session.blockFailingVerificationUntilEdit).toBe(false);
    expect(calls).toContain("diff");
    expect(calls).toContain("ledger");
    expect(calls).toContain("upper");
  });
});
