import { describe, expect, it, vi } from "vitest";
import { runClaudeStreamingPipeline } from "../src/streaming/claude-streaming-pipeline.js";

async function* parts(...items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

describe("runClaudeStreamingPipeline", () => {
  it("routes local events, tool calls, after-events counters, and lifecycle finalization", async () => {
    const handleLocalEvent = vi.fn((event: { type: string }) => event.type === "text_delta");
    const handleToolCall = vi.fn(async () => ({
      toolRepairs: 2,
      validationFailures: 1,
      strictGovernanceRewrites: 0,
      emittedToolCalls: 1,
    }));
    const afterEvents = vi.fn();
    const onEventError = vi.fn();
    const finalizeLifecycle = vi.fn(() => "tool_use");

    const result = await runClaudeStreamingPipeline({
      streamParts: parts(
        { type: "text-delta", text: "hello" },
        { type: "tool-call", toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } },
      ),
      handleLocalEvent,
      handleToolCall,
      afterEvents,
      onEventError,
      finalizeLifecycle,
    });

    expect(handleLocalEvent).toHaveBeenCalledTimes(2);
    expect(handleToolCall).toHaveBeenCalledWith({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "pwd" },
    });
    expect(afterEvents).toHaveBeenCalledWith({
      toolRepairs: 2,
      validationFailures: 1,
    });
    expect(onEventError).not.toHaveBeenCalled();
    expect(finalizeLifecycle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      toolRepairs: 2,
      validationFailures: 1,
      stopReason: "tool_use",
    });
  });

  it("routes stream errors to lifecycle handler and still finalizes", async () => {
    const error = new Error("boom");
    const afterEvents = vi.fn();
    const onEventError = vi.fn();
    const finalizeLifecycle = vi.fn(() => "end_turn");

    const result = await runClaudeStreamingPipeline({
      streamParts: parts({ type: "error", error }),
      handleLocalEvent: () => false,
      handleToolCall: vi.fn(),
      afterEvents,
      onEventError,
      finalizeLifecycle,
    });

    expect(afterEvents).not.toHaveBeenCalled();
    expect(onEventError).toHaveBeenCalledWith(error);
    expect(finalizeLifecycle).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("end_turn");
  });
});
