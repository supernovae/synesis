import { describe, expect, it } from "vitest";
import {
  classifyAiSdkStreamPart,
  parseToolInput,
  serializeToolInput,
} from "../src/streaming/ai-sdk-stream-events.js";

describe("AI SDK stream event normalization", () => {
  it("classifies text and reasoning deltas", () => {
    expect(classifyAiSdkStreamPart({ type: "text-delta", text: "hello" })).toEqual({
      type: "text_delta",
      text: "hello",
    });
    expect(classifyAiSdkStreamPart({ type: "reasoning-start", text: "plan" })).toEqual({
      type: "reasoning_start",
      text: "plan",
    });
    expect(classifyAiSdkStreamPart({ type: "reasoning-delta", textDelta: " next" })).toEqual({
      type: "reasoning_delta",
      text: " next",
    });
    expect(classifyAiSdkStreamPart({ type: "reasoning-end" })).toEqual({ type: "reasoning_end" });
  });

  it("classifies tool input events with stable defaults", () => {
    expect(classifyAiSdkStreamPart({ type: "tool-input-start", toolCallId: "tc1", toolName: "Bash" })).toEqual({
      type: "tool_input_start",
      toolCallId: "tc1",
      toolName: "Bash",
      input: undefined,
    });
    expect(classifyAiSdkStreamPart({ type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "{\"command\"" })).toEqual({
      type: "tool_input_delta",
      toolCallId: "tc1",
      inputTextDelta: "{\"command\"",
    });
    expect(classifyAiSdkStreamPart({ type: "tool-call", toolCallId: "tc1", toolName: "Bash", input: { command: "pwd" } })).toEqual({
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "pwd" },
    });
  });

  it("normalizes finish, error, and unknown events", () => {
    const err = new Error("boom");
    expect(classifyAiSdkStreamPart({ type: "finish", finishReason: "length" })).toEqual({
      type: "finish",
      finishReason: "length",
    });
    expect(classifyAiSdkStreamPart({ type: "error", error: err })).toEqual({ type: "error", error: err });
    expect(classifyAiSdkStreamPart({ type: "provider-metadata" })).toEqual({
      type: "unknown",
      rawType: "provider-metadata",
    });
  });

  it("serializes and parses tool input without ad hoc casts in stream loops", () => {
    expect(serializeToolInput({ command: "pwd" })).toBe("{\"command\":\"pwd\"}");
    expect(serializeToolInput("{\"command\":\"pwd\"}")).toBe("{\"command\":\"pwd\"}");
    expect(parseToolInput({ command: "pwd" }, "")).toEqual({ command: "pwd" });
    expect(parseToolInput("{\"command\":\"pwd\"}", "{\"command\":\"pwd\"}")).toEqual({ command: "pwd" });
    expect(parseToolInput("not-json", "not-json")).toEqual({});
  });
});
