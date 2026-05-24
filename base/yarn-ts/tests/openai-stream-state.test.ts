import { describe, expect, it } from "vitest";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";

describe("OpenAIStreamState", () => {
  it("buffers and drains text deltas", () => {
    const state = new OpenAIStreamState();

    state.appendTextDelta("hello");
    state.appendTextDelta("");
    state.appendTextDelta(" world");

    expect(state.hasPendingText()).toBe(true);
    expect(state.drainText()).toBe("hello world");
    expect(state.hasPendingText()).toBe(false);
    expect(state.drainText()).toBe("");
  });

  it("tracks pending tool calls and input deltas", () => {
    const state = new OpenAIStreamState();

    const first = state.startToolInput("tc1", "Bash");
    expect(first).toEqual({ index: 0, id: "tc1", name: "Bash", args: "" });
    expect(state.appendToolInputDelta("tc1", "{\"command\"")).toBe(true);
    expect(state.appendToolInputDelta("missing", "ignored")).toBe(false);
    expect(state.findToolCall("tc1")).toMatchObject({ args: "{\"command\"" });
    expect(state.nextToolCallIndex()).toBe(1);
    expect(state.removeToolCall("tc1")).toBe(true);
    expect(state.findToolCall("tc1")).toBeUndefined();
  });

  it("normalizes tool-call finish without emitted tool calls back to stop", () => {
    const state = new OpenAIStreamState();

    state.markToolCallFinish();

    expect(state.rawFinishReason()).toBe("tool_calls");
    expect(state.normalizedFinishReason(0)).toBe("stop");
  });
});
