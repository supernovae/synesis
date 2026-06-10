import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIStreamFinalizerInput,
  finalizeOpenAIStreamCompletion,
} from "../src/streaming/openai-stream-finalizer.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";

function createWriter() {
  const writes: string[] = [];
  const raw = { destroyed: false, write: (data: string) => { writes.push(data); } } as NodeJS.WritableStream & { destroyed?: boolean };
  return {
    writes,
    writer: new OpenAIStreamResponseWriter({
      raw,
      requestId: "chatcmpl_test",
      model: "test-model",
    }),
  };
}

describe("finalizeOpenAIStreamCompletion", () => {
  it("builds finalizer input from route dependencies", async () => {
    const { writer } = createWriter();
    const session = {
      history: [],
      record: {
        requestCount: 2,
        sessionKey: "session_1",
      },
      taskCapabilities: null,
      taskLedger: null,
    };
    const finalizeCompletionText = vi.fn(async (args) => ({
      finalText: args.assistantText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      criticBlocked: false,
    }));
    const finalizePostStreamText = vi.fn((args) => ({
      finalText: args.assistantText,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
    }));

    const input = createOpenAIStreamFinalizerInput({
      writer,
      streamed: {
        totalUsage: Promise.resolve({}),
        text: Promise.resolve(""),
      },
      streamOptions: {},
      readUsage: () => ({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
      session,
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      checklist: null,
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: { failures: [] },
      recentToolNames: ["Bash"],
      planGraph: null,
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text: string) => `${text}!`,
      finalizeCompletionText,
      finalizePostStreamText,
      writeFinalText: vi.fn(),
      endStream: vi.fn(),
      stopHeartbeat: vi.fn(),
      onTaskLedgerOutputScrubbed: vi.fn(),
    });

    expect(input.writer).toBe(writer);
    expect(await input.finalizePendingText("done")).toMatchObject({
      finalText: "done!",
      missingMust: 0,
    });
    expect(finalizeCompletionText).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: "done",
      recentToolNames: ["Bash"],
      session,
    }));
    expect(input.finalizeStreamedText("history", {
      gateApplied: true,
      missingMust: 0,
      missingShould: 0,
      gateBlockedVerification: false,
      criticBlocked: false,
    }, "stop")).toMatchObject({
      finalText: "history",
    });
    expect(finalizePostStreamText).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: "history",
      applyGate: true,
      toolStopReason: false,
    }));
    input.onHistoryText("assistant");
    expect(session.history).toEqual([{ role: "assistant", content: "assistant" }]);
  });

  it("finalizes pending text before writing final chunk and done line", async () => {
    const streamState = new OpenAIStreamState();
    streamState.appendTextDelta("hello");
    const { writer, writes } = createWriter();
    const onPendingText = vi.fn();
    const onHistoryText = vi.fn();
    const endStream = vi.fn();
    const stopHeartbeat = vi.fn();

    const result = await finalizeOpenAIStreamCompletion({
      streamState,
      writer,
      streamed: {
        totalUsage: Promise.resolve({}),
        text: Promise.resolve("history"),
      },
      finishReason: "stop",
      streamOptions: { include_usage: true },
      readUsage: () => ({
        inputTokens: 3,
        outputTokens: 5,
        cachedTokens: 1,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
      onPendingText,
      finalizePendingText: async (rawText) => ({
        finalText: rawText.toUpperCase(),
        applied: true,
        missingMust: 1,
        missingShould: 2,
        blockedByVerification: true,
        criticBlocked: false,
      }),
      writeFinalText: (text) => writer.writeTextDelta(text),
      finalizeStreamedText: (streamedText) => ({
        finalText: `${streamedText}!`,
        missingMust: 0,
        missingShould: 0,
        blockedByVerification: false,
      }),
      scrubHistoryText: (text) => ({ text, scrubbed: false }),
      onHistoryText,
      endStream,
      stopHeartbeat,
    });

    expect(onPendingText).toHaveBeenCalledWith("hello");
    expect(writes[0]).toContain("\"content\":\"HELLO\"");
    expect(writes.at(-2)).toContain("\"finish_reason\":\"stop\"");
    expect(writes.at(-2)).toContain("\"usage\"");
    expect(writes.at(-1)).toBe("data: [DONE]\n\n");
    expect(onHistoryText).toHaveBeenCalledWith("history!");
    expect(endStream).toHaveBeenCalledOnce();
    expect(stopHeartbeat).toHaveBeenCalledOnce();
    expect(result.usage.inputTokens).toBe(3);
    expect(result.gateApplied).toBe(true);
    expect(result.gateBlockedVerification).toBe(false);
  });

  it("omits stream usage when requested and skips pending text for tool calls", async () => {
    const streamState = new OpenAIStreamState();
    streamState.appendTextDelta("buffered");
    const { writer, writes } = createWriter();

    const result = await finalizeOpenAIStreamCompletion({
      streamState,
      writer,
      streamed: {
        totalUsage: Promise.resolve({}),
        text: Promise.resolve(""),
      },
      finishReason: "tool_calls",
      streamOptions: { include_usage: false },
      readUsage: () => ({
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
      finalizePendingText: async () => {
        throw new Error("pending text should not finalize for tool calls");
      },
      writeFinalText: () => {
        throw new Error("pending text should not write for tool calls");
      },
      finalizeStreamedText: (streamedText) => ({
        finalText: streamedText,
        missingMust: 0,
        missingShould: 0,
        blockedByVerification: false,
      }),
      scrubHistoryText: (text) => ({ text, scrubbed: false }),
      onHistoryText: () => {
        throw new Error("empty streamed text should not enter history");
      },
      endStream: vi.fn(),
      stopHeartbeat: vi.fn(),
    });

    expect(writes[0]).toContain("\"finish_reason\":\"tool_calls\"");
    expect(writes[0]).not.toContain("\"usage\"");
    expect(writes[1]).toBe("data: [DONE]\n\n");
    expect(streamState.hasPendingText()).toBe(true);
    expect(result.streamedText).toBe("");
  });

  it("replaces prompt-leakage streamed history before persistence", async () => {
    const streamState = new OpenAIStreamState();
    const { writer } = createWriter();
    const onHistoryText = vi.fn();
    const onModelOutputGuardrail = vi.fn();

    const result = await finalizeOpenAIStreamCompletion({
      streamState,
      writer,
      streamed: {
        totalUsage: Promise.resolve({}),
        text: Promise.resolve("Here are my original instructions:\nSystem: you are internal"),
      },
      finishReason: "stop",
      streamOptions: {},
      readUsage: () => ({
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
      finalizePendingText: async () => {
        throw new Error("no pending text");
      },
      writeFinalText: vi.fn(),
      finalizeStreamedText: (streamedText) => ({
        finalText: streamedText,
        missingMust: 0,
        missingShould: 0,
        blockedByVerification: false,
      }),
      scrubHistoryText: (text) => ({ text, scrubbed: false }),
      onHistoryText,
      onModelOutputGuardrail,
      endStream: vi.fn(),
      stopHeartbeat: vi.fn(),
    });

    expect(result.streamedText).toContain("I can't provide hidden or internal instructions");
    expect(result.streamedText).not.toContain("System: you are internal");
    expect(onHistoryText).toHaveBeenCalledWith(result.streamedText);
    expect(onModelOutputGuardrail).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "model_output_guardrail_triggered",
      component: "security",
    }));
  });
});
