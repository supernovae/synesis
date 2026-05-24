import { describe, expect, it, vi } from "vitest";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";
import { runOpenAIStreamingPipeline } from "../src/streaming/openai-streaming-pipeline.js";
import type { OpenAIStreamTelemetryInput } from "../src/streaming/openai-stream-telemetry.js";

async function* streamParts(parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) {
    yield part;
  }
}

function telemetryInput(args: {
  finishReason: string;
  state: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
}): OpenAIStreamTelemetryInput {
  return {
    requestId: "req_1",
    sessionKey: "session_1",
    userId: "user_1",
    orgId: "org_1",
    startedAtMs: Date.now(),
    finishReason: args.finishReason,
    resolvedModelId: "model-a",
    clientRequestedModel: "model-a",
    streamFinalized: {
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
      streamedText: "",
      gateApplied: false,
      missingMust: 0,
      missingShould: 0,
      gateBlockedVerification: false,
      criticBlocked: false,
    },
    reductions: {
      toolResultReduction: {
        getPerRequestDelta: () => 0,
        getPerRequestGuidedTruncationDelta: () => 0,
        getPerRequestTaskPrunedDelta: () => 0,
        getLastRecallDecision: () => null,
        getVerificationTracker: () => ({ getState: () => ({ round: 0, findings: [], stalled: false }) }),
      },
      validationNormalization: { getPerRequestDelta: () => 0 },
    },
    reducedToolResults: 0,
    orchestration: {
      phase: "build",
      tier: "pulse",
      decisionPath: "direct",
      escalated: false,
    } as never,
    policyMatchedRules: [],
    optimizationLedger: {
      setUpstreamCachedTokens: vi.fn(),
      recordFinal: vi.fn(),
      finalize: vi.fn(() => ({})),
      toLogRecord: vi.fn(() => ({})),
    },
    normalizedMessages: [],
    toolNames: args.state.toolNames(),
    inferVerificationSteps: () => [],
    toolDefinitionCount: 0,
    artifactToolInjected: false,
    knowledgeToolInjected: false,
    finalizeRequestForensics: () => undefined,
    recordSessionEvent: vi.fn(),
    persistDecisionTelemetry: vi.fn(),
    countMessageRoles: () => ({
      systemMessageCount: 0,
      userMessageCount: 0,
      toolMessageCount: 0,
      totalInputChars: 0,
    }),
    pushDiagnostic: vi.fn(),
    logOptimizationLedger: vi.fn(),
  };
}

function pipelineHarness() {
  const writes: string[] = [];
  const raw = { destroyed: false, write: (data: string) => { writes.push(data); } } as NodeJS.WritableStream & { destroyed?: boolean };
  const writer = new OpenAIStreamResponseWriter({
    raw,
    requestId: "chatcmpl_test",
    model: "test-model",
  });
  const streamState = new OpenAIStreamState();
  return { writes, writer, streamState };
}

describe("runOpenAIStreamingPipeline", () => {
  it("runs events, finalization, and telemetry in sequence", async () => {
    const { writes, writer, streamState } = pipelineHarness();
    const order: string[] = [];

    const result = await runOpenAIStreamingPipeline({
      streamParts: streamParts([
        { type: "text-delta", text: "hello" },
        { type: "finish", finishReason: "length" },
      ]),
      streamState,
      eventHandlers: {
        onTextDelta: (event) => {
          order.push("text");
          streamState.appendTextDelta(event.text);
        },
        onFinish: (event) => {
          order.push("finish");
          if (event.finishReason === "length") streamState.markLengthFinish();
        },
      },
      afterEvents: () => { order.push("after"); },
      beforeFinalize: (finishReason) => { order.push(`before:${finishReason}`); },
      finalizerInput: {
        writer,
        streamed: { totalUsage: Promise.resolve({}), text: Promise.resolve("") },
        streamOptions: {},
        readUsage: () => ({
          inputTokens: 1,
          outputTokens: 2,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        }),
        finalizePendingText: async (rawText) => ({
          finalText: rawText.toUpperCase(),
          missingMust: 0,
          missingShould: 0,
          blockedByVerification: false,
        }),
        writeFinalText: (text) => writer.writeTextDelta(text),
        finalizeStreamedText: (text) => ({
          finalText: text,
          missingMust: 0,
          missingShould: 0,
          blockedByVerification: false,
        }),
        scrubHistoryText: (text) => ({ text, scrubbed: false }),
        onHistoryText: vi.fn(),
        endStream: () => { order.push("end"); },
        stopHeartbeat: () => { order.push("heartbeat"); },
      },
      buildTelemetryInput: ({ finishReason }) => {
        order.push(`telemetry:${finishReason}`);
        return telemetryInput({ finishReason, state: streamState, writer });
      },
    });

    expect(order).toEqual(["text", "finish", "after", "before:length", "end", "heartbeat", "telemetry:length"]);
    expect(result.finishReason).toBe("length");
    expect(writes[0]).toContain("\"content\":\"HELLO\"");
    expect(writes.at(-2)).toContain("\"finish_reason\":\"length\"");
    expect(writes.at(-1)).toBe("data: [DONE]\n\n");
  });

  it("routes stream errors through the error callback before finalizing", async () => {
    const { writes, writer, streamState } = pipelineHarness();
    const afterEvents = vi.fn();

    const result = await runOpenAIStreamingPipeline({
      streamParts: streamParts([{ type: "error", error: new Error("upstream") }]),
      streamState,
      eventHandlers: {},
      afterEvents,
      onEventError: () => {
        streamState.markError();
        writer.writeTextDelta("error hint");
      },
      beforeFinalize: vi.fn(),
      finalizerInput: {
        writer,
        streamed: { totalUsage: Promise.resolve({}), text: Promise.resolve("") },
        streamOptions: {},
        readUsage: () => ({
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        }),
        finalizePendingText: async () => {
          throw new Error("no pending text expected");
        },
        writeFinalText: vi.fn(),
        finalizeStreamedText: (text) => ({
          finalText: text,
          missingMust: 0,
          missingShould: 0,
          blockedByVerification: false,
        }),
        scrubHistoryText: (text) => ({ text, scrubbed: false }),
        onHistoryText: vi.fn(),
        endStream: vi.fn(),
        stopHeartbeat: vi.fn(),
      },
      buildTelemetryInput: ({ finishReason }) => telemetryInput({ finishReason, state: streamState, writer }),
    });

    expect(afterEvents).not.toHaveBeenCalled();
    expect(result.finishReason).toBe("error");
    expect(writes[0]).toContain("error hint");
    expect(writes.at(-2)).toContain("\"finish_reason\":\"error\"");
  });
});
