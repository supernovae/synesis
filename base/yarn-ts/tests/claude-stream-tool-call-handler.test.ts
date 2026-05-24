import { describe, expect, it, vi } from "vitest";
import type { ToolArgHardeningStats } from "../src/governance/tool-call-observability.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";
import { handleClaudeStreamToolCall } from "../src/streaming/claude-stream-tool-call-handler.js";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";
import type { GuardrailToolCall } from "../src/tools/tool-call-availability.js";

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

function harness(overrides: Partial<Parameters<typeof handleClaudeStreamToolCall>[0]> = {}) {
  const streamState = new ClaudeStreamState();
  const acceptedGuardrailCalls: GuardrailToolCall[] = [];
  const blockedDiscoveryDetails: Parameters<typeof handleClaudeStreamToolCall>[0]["blockedDiscoveryDetails"] = [];
  const discovery = {
    recoveryPreviewEntries: 0,
    recoveryMode: null,
    blockedBroadDiscovery: 0,
    collapsedBroadDiscovery: 0,
  };
  const toolSequence: string[] = [];
  const sendSse = vi.fn(() => true);
  const adapter: ModelAdapter = {
    family: "test",
    supportsThinking: false,
  };
  const callbacks = {
    onWriteCapableTool: vi.fn(),
    onGitInspectionChurnBlock: vi.fn(),
    onGovernedToolCall: vi.fn(),
    onPlanWriteAudit: vi.fn(),
    onEnvelopeUnwrapSample: vi.fn(),
    onUpperHarnessDecision: vi.fn(),
    onStrictGovernanceRewrites: vi.fn(),
    onRedirectedDiscovery: vi.fn(),
  };
  return {
    streamState,
    acceptedGuardrailCalls,
    blockedDiscoveryDetails,
    discovery,
    toolSequence,
    sendSse,
    callbacks,
    input: {
      event: {
        type: "tool_call" as const,
        toolCallId: "tc1",
        toolName: "Bash",
        input: { command: "pwd" },
      },
      streamState,
      adapter,
      requestId: "req_1",
      clientKind: "claude-code",
      debugProtocol: false,
      strictGovernance: false,
      governanceOptions: {
        enforcePathRoot: false,
        blockBashPathDrift: false,
      },
      acceptedGuardrailCalls,
      blockedDiscoveryDetails,
      discovery,
      toolSequence,
      stats: stats(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      isWriteCapableToolName: () => false,
      getTopLevelDirs: async () => [],
      applyDiscoveryGuardrail: (calls: GuardrailToolCall[]) => ({
        calls,
        blockedCount: 0,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [],
      }),
      buildBlockedDiscoveryRecovery: async () => ({
        text: "recovery",
        entryCount: 1,
        recoveryMode: "top_level_snapshot" as const,
      }),
      sendSse,
      ...callbacks,
      ...overrides,
    },
  };
}

describe("handleClaudeStreamToolCall", () => {
  it("emits Claude tool-use blocks and records governed state", async () => {
    const h = harness();

    const result = await handleClaudeStreamToolCall(h.input);

    expect(result.emittedToolCalls).toBe(1);
    expect(result.toolRepairs).toBe(0);
    expect(h.acceptedGuardrailCalls).toEqual([
      { toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
    ]);
    expect(h.toolSequence).toEqual(["Bash"]);
    expect(h.callbacks.onGovernedToolCall).toHaveBeenCalledOnce();
    expect(h.sendSse).toHaveBeenNthCalledWith(1, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tc1", name: "Bash" },
    });
    expect(h.sendSse).toHaveBeenNthCalledWith(2, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
    });
    expect(h.streamState.rawStopReason()).toBe("tool_use");
    expect(h.streamState.currentBlockIndex()).toBe(1);
  });

  it("emits deterministic recovery text when broad discovery is blocked", async () => {
    const h = harness({
      applyDiscoveryGuardrail: () => ({
        calls: [],
        blockedCount: 1,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [{ toolName: "Glob", reason: "empty_glob_pattern_blocked" }],
      }),
      buildBlockedDiscoveryRecovery: async () => ({
        text: "Use a scoped Glob",
        entryCount: 1,
        recoveryMode: "top_level_snapshot",
      }),
    });
    h.streamState.startToolInput("tc1", "Glob");

    const result = await handleClaudeStreamToolCall({
      ...h.input,
      event: {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "Glob",
        input: { pattern: "" },
      },
    });

    expect(result.emittedToolCalls).toBe(0);
    expect(h.discovery.blockedBroadDiscovery).toBe(1);
    expect(h.discovery.recoveryPreviewEntries).toBe(1);
    expect(h.discovery.recoveryMode).toBe("top_level_snapshot");
    expect(h.blockedDiscoveryDetails).toEqual([{ toolName: "Glob", reason: "empty_glob_pattern_blocked" }]);
    expect(h.streamState.getToolInput("tc1")).toBeUndefined();
    expect(h.sendSse).toHaveBeenCalledWith("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "\nUse a scoped Glob\n" },
    });
  });
});
