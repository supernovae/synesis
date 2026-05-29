import { describe, expect, it } from "vitest";
import { prepareOpenAINonStreamExternalToolCalls } from "../src/pipeline/openai-nonstream-tool-calls.js";

function stats() {
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

describe("prepareOpenAINonStreamExternalToolCalls", () => {
  it("hardens non-stream tool calls and applies route side effects", () => {
    const calls: string[] = [];
    const session = {
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: true,
      gitInspectionBlockCount: 0,
      artifactEditTurns: new Map<string, number>(),
      record: { metadata: {} },
    };
    const result = prepareOpenAINonStreamExternalToolCalls({
      toolCalls: [
        { toolCallId: "artifact-1", toolName: "artifact", input: {} },
        { toolCallId: "write-1", toolName: "Write", input: { file_path: "a.txt", content: "hello" } },
      ],
      artifactToolName: "artifact",
      adapter: {
        family: "openai",
        normalizeToolName: (name: string) => name,
        restoreToolNameForClient: (name: string) => name,
        normalizeToolCallInput: (name: string, input: Record<string, unknown>) => ({ toolName: name, input, repaired: false }),
      } as never,
      effectiveTools: [{ type: "function", function: { name: "Write" } }],
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
      normalizedMessageCount: 5,
      pathSandboxEnabled: false,
      deserializePlanShadow: () => null,
      buildPathSandboxPolicy: () => ({}) as never,
      isWriteCapableToolName: (name) => name === "Write",
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
      logger: { warn: () => undefined, info: () => undefined },
      requestId: "req-1",
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      recordUpperHarnessDecision: () => calls.push("upper"),
      updateDiffAccumulator: () => calls.push("diff"),
      maybeUpdateTaskLedgerFromToolCall: () => calls.push("ledger"),
      emitPlanWriteAuditEvent: () => calls.push("audit"),
      maybeLogEnvelopeUnwrapSample: () => calls.push("unwrap"),
    });

    expect(result).toEqual([
      { toolCallId: "write-1", toolName: "Write", input: { file_path: "a.txt", content: "hello" } },
    ]);
    expect(session.blockBroadVerificationUntilEdit).toBe(false);
    expect(session.blockFailingVerificationUntilEdit).toBe(false);
    expect(calls).toEqual(["upper", "diff", "ledger", "unwrap"]);
  });

  it("uses session workspace metadata before blocking absolute file tools", () => {
    const calls: string[] = [];
    const session = {
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: true,
      gitInspectionBlockCount: 0,
      artifactEditTurns: new Map<string, number>(),
      record: {
        metadata: {
          workspace_context_cwd: "/home/byron/src/test",
          workspace_context_project_root: "/home/byron/src/test",
        },
      },
    };

    const result = prepareOpenAINonStreamExternalToolCalls({
      toolCalls: [
        {
          toolCallId: "write-1",
          toolName: "Write",
          input: { file_path: "/home/byron/src/test/requirements.txt", content: "fastapi\n" },
        },
      ],
      artifactToolName: "artifact",
      adapter: {
        family: "openai",
        normalizeToolName: (name: string) => name,
        restoreToolNameForClient: (name: string) => name,
        normalizeToolCallInput: (name: string, input: Record<string, unknown>) => ({ toolName: name, input, repaired: false }),
      } as never,
      effectiveTools: [
        { type: "function", function: { name: "Write" } },
        { type: "function", function: { name: "Bash" } },
      ],
      clientKind: "opencode",
      recentToolNames: [],
      pathContext: {},
      enforcePathRoot: true,
      blockBashPathDrift: true,
      strictGovernance: false,
      planModeRequested: false,
      session,
      shouldRestrictDiscoveryForPlanWork: () => false,
      taskCue: undefined,
      artifactShadows: new Map(),
      normalizedMessageCount: 5,
      pathSandboxEnabled: true,
      deserializePlanShadow: () => null,
      buildPathSandboxPolicy: (projectRoot: string) => ({
        projectRoot,
        homeDir: "/home/byron",
        allowedReadGlobs: [],
        allowedWriteGlobs: [],
        blockedGlobs: [],
      }),
      isWriteCapableToolName: (name) => name === "Write",
      stats: stats(),
      strictGovernanceStats: { strictGovernanceRewrites: 0 },
      logger: { warn: () => undefined, info: () => undefined },
      requestId: "req-1",
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      recordUpperHarnessDecision: () => calls.push("upper"),
      updateDiffAccumulator: () => calls.push("diff"),
      maybeUpdateTaskLedgerFromToolCall: () => calls.push("ledger"),
      emitPlanWriteAuditEvent: () => calls.push("audit"),
      maybeLogEnvelopeUnwrapSample: () => calls.push("unwrap"),
    });

    expect(result).toEqual([
      {
        toolCallId: "write-1",
        toolName: "Write",
        input: { file_path: "requirements.txt", content: "fastapi\n" },
      },
    ]);
    expect(calls).toEqual(["upper", "diff", "ledger", "unwrap"]);
  });
});
