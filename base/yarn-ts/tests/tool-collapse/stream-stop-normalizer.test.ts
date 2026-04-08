import { describe, expect, it } from "vitest";
import {
  normalizeClaudeStreamStopReason,
  normalizeOpenAIStreamFinishReason,
} from "../../src/tool-collapse/stream-stop-normalizer.js";

describe("stream-stop-normalizer", () => {
  it("normalizes OpenAI tool_calls to stop when no tool call emitted", () => {
    expect(normalizeOpenAIStreamFinishReason("tool_calls", 0)).toBe("stop");
    expect(normalizeOpenAIStreamFinishReason("tool_calls", 2)).toBe("tool_calls");
  });

  it("normalizes Claude tool_use to end_turn when no tool call emitted", () => {
    expect(normalizeClaudeStreamStopReason("tool_use", 0)).toBe("end_turn");
    expect(normalizeClaudeStreamStopReason("tool_use", 1)).toBe("tool_use");
  });
});
