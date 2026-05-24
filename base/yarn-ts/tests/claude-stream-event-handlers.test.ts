import { describe, expect, it, vi } from "vitest";
import { handleClaudeStreamLocalEvent } from "../src/streaming/claude-stream-event-handlers.js";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";

function harness() {
  return {
    streamState: new ClaudeStreamState(),
    sendSse: vi.fn(() => true),
    scrubAndFlushTextBlock: vi.fn(),
  };
}

describe("handleClaudeStreamLocalEvent", () => {
  it("buffers text deltas and flushes pending text before thinking blocks", () => {
    const input = harness();

    expect(handleClaudeStreamLocalEvent({ type: "text_delta", text: "hello" }, input)).toBe(true);
    expect(input.streamState.hasPendingText()).toBe(true);

    expect(handleClaudeStreamLocalEvent({ type: "reasoning_start", text: "thinking" }, input)).toBe(true);

    expect(input.scrubAndFlushTextBlock).toHaveBeenCalledWith("hello");
    expect(input.sendSse).toHaveBeenNthCalledWith(1, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(input.sendSse).toHaveBeenNthCalledWith(2, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "thinking" },
    });
  });

  it("writes reasoning deltas and closes the current reasoning block", () => {
    const input = harness();

    expect(handleClaudeStreamLocalEvent({ type: "reasoning_delta", text: "more" }, input)).toBe(true);
    expect(handleClaudeStreamLocalEvent({ type: "reasoning_end" }, input)).toBe(true);

    expect(input.sendSse).toHaveBeenNthCalledWith(1, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "more" },
    });
    expect(input.sendSse).toHaveBeenNthCalledWith(2, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    expect(input.streamState.currentBlockIndex()).toBe(1);
  });

  it("tracks tool input chunks without consuming final tool calls", () => {
    const input = harness();

    expect(handleClaudeStreamLocalEvent({
      type: "tool_input_start",
      toolCallId: "call_1",
      toolName: "Bash",
      input: {},
    }, input)).toBe(true);
    expect(handleClaudeStreamLocalEvent({
      type: "tool_input_delta",
      toolCallId: "call_1",
      inputTextDelta: "{\"cmd\":\"pwd\"}",
    }, input)).toBe(true);

    expect(input.streamState.getToolInput("call_1")?.chunks).toEqual(["{\"cmd\":\"pwd\"}"]);
    expect(handleClaudeStreamLocalEvent({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "Bash",
      input: { cmd: "pwd" },
    }, input)).toBe(false);
  });

  it("records provider finish markers and leaves errors for the caller", () => {
    const input = harness();

    expect(handleClaudeStreamLocalEvent({ type: "finish", finishReason: "length" }, input)).toBe(true);
    expect(input.streamState.rawStopReason()).toBe("max_tokens");
    expect(handleClaudeStreamLocalEvent({ type: "error", error: new Error("boom") }, input)).toBe(false);
    expect(handleClaudeStreamLocalEvent({ type: "unknown", rawType: "x" }, input)).toBe(false);
  });
});
