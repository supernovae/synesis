import { describe, expect, it } from "vitest";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";

describe("ClaudeStreamState", () => {
  it("tracks content block indexes and text block state", () => {
    const state = new ClaudeStreamState();

    expect(state.currentBlockIndex()).toBe(0);
    expect(state.closeTextBlock()).toBeNull();

    state.markTextBlockOpen();
    expect(state.isTextBlockOpen()).toBe(true);
    expect(state.isInTextBlock()).toBe(true);
    expect(state.closeTextBlock()).toBe(0);
    expect(state.currentBlockIndex()).toBe(1);
    expect(state.isTextBlockOpen()).toBe(false);
    expect(state.isInTextBlock()).toBe(false);

    expect(state.advanceBlock()).toBe(1);
    expect(state.currentBlockIndex()).toBe(2);
  });

  it("buffers and drains text deltas", () => {
    const state = new ClaudeStreamState();

    state.appendTextDelta("hello");
    state.appendTextDelta("");
    state.appendTextDelta(" world");

    expect(state.hasPendingText()).toBe(true);
    expect(state.drainText()).toBe("hello world");
    expect(state.hasPendingText()).toBe(false);
  });

  it("tracks pending tool input chunks", () => {
    const state = new ClaudeStreamState();

    expect(state.startToolInput("toolu_1", "Bash")).toEqual({
      toolName: "Bash",
      toolCallId: "toolu_1",
      chunks: [],
    });
    expect(state.rawStopReason()).toBe("tool_use");
    expect(state.appendToolInputDelta("toolu_1", "{\"command\"")).toBe(true);
    expect(state.appendToolInputDelta("missing", "ignored")).toBe(false);
    expect(state.getToolInput("toolu_1")?.chunks).toEqual(["{\"command\""]);
    expect(state.pendingToolInputCount()).toBe(1);
    expect(state.removeToolInput("toolu_1")).toBe(true);
    expect(state.pendingToolInputCount()).toBe(0);
  });

  it("normalizes tool_use without emitted tool calls back to end_turn", () => {
    const state = new ClaudeStreamState();

    state.markToolUse();

    expect(state.normalizedStopReason()).toBe("end_turn");

    state.markToolUse();
    state.recordEmittedToolCall();
    expect(state.normalizedStopReason()).toBe("tool_use");
  });
});
