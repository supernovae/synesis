import { describe, expect, it, vi } from "vitest";
import { runOpenAIStreamEvents } from "../src/streaming/openai-stream-event-runner.js";

async function* streamParts(parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) {
    yield part;
  }
}

describe("runOpenAIStreamEvents", () => {
  it("dispatches classified stream events in order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T12:34:56Z"));
    const seen: string[] = [];

    await runOpenAIStreamEvents(streamParts([
      { type: "text-delta", text: "hello" },
      { type: "reasoning-start", text: "plan" },
      { type: "reasoning-delta", textDelta: " more" },
      { type: "reasoning-end" },
      { type: "tool-input-start", toolCallId: "tc1", toolName: "Bash" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "{\"command\"" },
      { type: "tool-call", toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
      { type: "finish", finishReason: "length" },
      { type: "provider-metadata" },
    ]), {
      onTextDelta: (event) => { seen.push(`text:${event.text}`); },
      onReasoningDelta: (event) => { seen.push(`reasoning:${event.text}`); },
      onReasoningEnd: () => { seen.push("reasoning:end"); },
      onToolInputStart: (event) => { seen.push(`tool-start:${event.toolCallId}:${event.toolName}`); },
      onToolInputDelta: (event) => { seen.push(`tool-delta:${event.inputTextDelta}`); },
      onToolCall: (event) => { seen.push(`tool-call:${event.toolCallId}:${event.created}`); },
      onFinish: (event) => { seen.push(`finish:${String(event.finishReason)}`); },
      onUnknown: (event) => { seen.push(`unknown:${event.rawType}`); },
    });

    expect(seen).toEqual([
      "text:hello",
      "reasoning:plan",
      "reasoning: more",
      "reasoning:end",
      "tool-start:tc1:Bash",
      "tool-delta:{\"command\"",
      "tool-call:tc1:1779539696",
      "finish:length",
      "unknown:provider-metadata",
    ]);
    vi.useRealTimers();
  });

  it("throws classified stream errors", async () => {
    const err = new Error("upstream failed");

    await expect(runOpenAIStreamEvents(streamParts([
      { type: "error", error: err },
    ]), {})).rejects.toThrow("upstream failed");
  });
});
