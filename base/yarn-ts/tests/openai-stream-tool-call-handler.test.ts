import { describe, expect, it, vi } from "vitest";
import { handleOpenAIStreamToolCall } from "../src/streaming/openai-stream-tool-call-handler.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";
import type { ToolArgHardeningStats } from "../src/governance/tool-call-observability.js";
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

function harness(overrides: Partial<Parameters<typeof handleOpenAIStreamToolCall>[0]> = {}) {
  const writes: string[] = [];
  const raw = { destroyed: false, write: (data: string) => { writes.push(data); } } as NodeJS.WritableStream & { destroyed?: boolean };
  const streamState = new OpenAIStreamState();
  const writer = new OpenAIStreamResponseWriter({
    raw,
    requestId: "chatcmpl_test",
    model: "test-model",
  });
  const adapter: ModelAdapter = {
    family: "test",
    supportsThinking: false,
  };
  const acceptedGuardrailCalls: GuardrailToolCall[] = [];
  const blockedDiscoveryDetails: Parameters<typeof handleOpenAIStreamToolCall>[0]["blockedDiscoveryDetails"] = [];
  const callbacks = {
    onWriteCapableTool: vi.fn(),
    onGitInspectionChurnBlock: vi.fn(),
    onGovernedToolCall: vi.fn(),
    onPlanWriteAudit: vi.fn(),
    onEnvelopeUnwrapSample: vi.fn(),
    onUpperHarnessDecision: vi.fn(),
    onRedirectedDiscovery: vi.fn(),
  };
  return {
    writes,
    streamState,
    acceptedGuardrailCalls,
    blockedDiscoveryDetails,
    callbacks,
    input: {
      event: {
        type: "tool_call" as const,
        toolCallId: "tc1",
        toolName: "Bash",
        input: { command: "pwd" },
        created: 123,
      },
      streamState,
      writer,
      adapter,
      requestId: "req_1",
      clientKind: "opencode",
      effectiveTools: [],
      debugProtocol: false,
      strictGovernance: false,
      hardeningOptions: {},
      governanceOptions: {
        enforcePathRoot: false,
        blockBashPathDrift: false,
      },
      availability: {
        offeredToolSet: new Set(["bash"]),
        offeredToolNames: ["Bash"],
        fallbackBashToolName: "Bash",
      },
      acceptedGuardrailCalls,
      blockedDiscoveryDetails,
      stats: stats(),
      logger: {
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
      ...callbacks,
      ...overrides,
    },
  };
}

describe("handleOpenAIStreamToolCall", () => {
  it("emits a client tool-call delta and records governed callbacks", async () => {
    const h = harness();

    const result = await handleOpenAIStreamToolCall(h.input);

    expect(result.emittedToolCalls).toBe(1);
    expect(result.blockedBroadDiscovery).toBe(0);
    expect(h.acceptedGuardrailCalls).toEqual([
      { toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
    ]);
    expect(h.callbacks.onGovernedToolCall).toHaveBeenCalledOnce();
    expect(h.writes[0]).toContain("\"created\":123");
    expect(h.writes[0]).toContain("\"tool_calls\"");
    expect(h.writes[0]).toContain("\"name\":\"Bash\"");
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

    const result = await handleOpenAIStreamToolCall({
      ...h.input,
      event: {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "Glob",
        input: { pattern: "" },
        created: 123,
      },
    });

    expect(result.emittedToolCalls).toBe(0);
    expect(result.blockedBroadDiscovery).toBe(1);
    expect(result.recoveryPreviewEntries).toBe(1);
    expect(result.recoveryMode).toBe("top_level_snapshot");
    expect(h.blockedDiscoveryDetails).toEqual([{ toolName: "Glob", reason: "empty_glob_pattern_blocked" }]);
    expect(h.streamState.findToolCall("tc1")).toBeUndefined();
    expect(h.writes.join("")).toContain("Use a scoped Glob");
  });
});
