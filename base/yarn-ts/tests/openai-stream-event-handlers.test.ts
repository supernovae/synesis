import { describe, expect, it, vi } from "vitest";
import { createOpenAIStreamEventHandlers } from "../src/streaming/openai-stream-event-handlers.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";
import {
  createOpenAIStreamToolCallAccumulator,
  type OpenAIStreamToolCallHandlerInput,
} from "../src/streaming/openai-stream-tool-call-handler.js";
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

function harness(overrides: Partial<Parameters<typeof createOpenAIStreamEventHandlers>[0]> = {}) {
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
  const blockedDiscoveryDetails: OpenAIStreamToolCallHandlerInput["blockedDiscoveryDetails"] = [];
  const accumulator = createOpenAIStreamToolCallAccumulator();
  const scrubAndFlushText = vi.fn((text: string) => writer.writeTextDelta(text));
  return {
    writes,
    streamState,
    writer,
    acceptedGuardrailCalls,
    blockedDiscoveryDetails,
    accumulator,
    scrubAndFlushText,
    handlers: createOpenAIStreamEventHandlers({
      streamState,
      writer,
      adapter,
      requestId: "req_1",
      clientKind: "opencode",
      effectiveTools: [],
      debugProtocol: false,
      strictGovernance: false,
      recentToolNames: [],
      governanceOptions: () => ({
        enforcePathRoot: false,
        blockBashPathDrift: false,
      }),
      availability: {
        offeredToolSet: new Set(["bash"]),
        offeredToolNames: ["Bash"],
        fallbackBashToolName: "Bash",
      },
      acceptedGuardrailCalls,
      blockedDiscoveryDetails,
      stats: stats(),
      logger: { warn: vi.fn(), debug: vi.fn() },
      accumulator,
      scrubAndFlushText,
      isWriteCapableToolName: () => false,
      onWriteCapableTool: vi.fn(),
      onGitInspectionChurnBlock: vi.fn(),
      onGovernedToolCall: vi.fn(),
      onPlanWriteAudit: vi.fn(),
      onEnvelopeUnwrapSample: vi.fn(),
      onUpperHarnessDecision: vi.fn(),
      onStrictGovernanceRewrites: vi.fn(),
      onRedirectedDiscovery: vi.fn(),
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
        recoveryMode: "top_level_snapshot",
      }),
      ...overrides,
    }),
  };
}

describe("createOpenAIStreamEventHandlers", () => {
  it("buffers text, flushes before tool input, and tracks tool input deltas", async () => {
    const h = harness();

    h.handlers.onTextDelta?.({ type: "text_delta", text: "hello" });
    h.handlers.onToolInputStart?.({ type: "tool_input_start", toolCallId: "tc1", toolName: "Bash", input: undefined });
    h.handlers.onToolInputDelta?.({ type: "tool_input_delta", toolCallId: "tc1", inputTextDelta: "{\"command\"" });

    expect(h.scrubAndFlushText).toHaveBeenCalledWith("hello");
    expect(h.streamState.findToolCall("tc1")).toMatchObject({
      id: "tc1",
      name: "Bash",
      args: "{\"command\"",
    });
  });

  it("handles tool calls through the extracted handler and accumulates result counters", async () => {
    const h = harness();

    await h.handlers.onToolCall?.({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "pwd" },
      created: 123,
    });

    expect(h.accumulator.emittedToolCalls).toBe(1);
    expect(h.acceptedGuardrailCalls).toEqual([
      { toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
    ]);
    expect(h.writes[0]).toContain("\"tool_calls\"");
    expect(h.writes[0]).toContain("\"created\":123");
  });

  it("marks length finish reasons", () => {
    const h = harness();

    h.handlers.onFinish?.({ type: "finish", finishReason: "length" });

    expect(h.streamState.rawFinishReason()).toBe("length");
  });
});
