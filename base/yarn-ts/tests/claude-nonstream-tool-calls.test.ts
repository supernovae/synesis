import { describe, expect, it, vi } from "vitest";
import type { ToolArgHardeningStats } from "../src/governance/tool-call-observability.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";
import { prepareClaudeNonStreamToolCalls } from "../src/streaming/claude-nonstream-tool-calls.js";

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

describe("prepareClaudeNonStreamToolCalls", () => {
  it("hardens and governs Claude non-stream tool calls", () => {
    const callbacks = {
      onWriteCapableTool: vi.fn(),
      onGitInspectionChurnBlock: vi.fn(),
      onGovernedToolCall: vi.fn(),
      onPlanWriteAudit: vi.fn(),
      onEnvelopeUnwrapSample: vi.fn(),
      onUpperHarnessDecision: vi.fn(),
      onStrictGovernanceRewrites: vi.fn(),
    };

    const calls = prepareClaudeNonStreamToolCalls({
      toolCalls: [{ toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } }],
      adapter: { family: "test", supportsThinking: false } as ModelAdapter,
      requestId: "req_1",
      clientKind: "claude-code",
      strictGovernance: false,
      governanceOptions: () => ({
        enforcePathRoot: false,
        blockBashPathDrift: false,
        clientKind: "claude-code",
      }),
      stats: stats(),
      logger: { warn: vi.fn() },
      isWriteCapableToolName: () => false,
      ...callbacks,
    });

    expect(calls).toEqual([
      { toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
    ]);
    expect(callbacks.onUpperHarnessDecision).toHaveBeenCalledOnce();
    expect(callbacks.onGovernedToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onEnvelopeUnwrapSample).toHaveBeenCalledWith(
      "Bash",
      expect.objectContaining({ toolName: "Bash", input: { command: "pwd" } }),
      "tc1",
    );
  });

  it("normalizes non-object tool input and clears verification blocks for write-capable tools", () => {
    const onWriteCapableTool = vi.fn();

    const calls = prepareClaudeNonStreamToolCalls({
      toolCalls: [{ toolCallId: "tc1", toolName: "Write", input: "bad" }],
      adapter: { family: "test", supportsThinking: false } as ModelAdapter,
      requestId: "req_1",
      clientKind: "claude-code",
      strictGovernance: false,
      governanceOptions: () => ({
        enforcePathRoot: false,
        blockBashPathDrift: false,
        clientKind: "claude-code",
      }),
      stats: stats(),
      logger: { warn: vi.fn() },
      isWriteCapableToolName: (name) => name === "Write",
      onWriteCapableTool,
      onGitInspectionChurnBlock: vi.fn(),
      onGovernedToolCall: vi.fn(),
      onPlanWriteAudit: vi.fn(),
      onEnvelopeUnwrapSample: vi.fn(),
      onUpperHarnessDecision: vi.fn(),
      onStrictGovernanceRewrites: vi.fn(),
    });

    expect(onWriteCapableTool).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({
      toolCallId: "tc1",
      toolName: "Synesis_Error_ValidationFailed",
      input: {},
    });
  });
});
