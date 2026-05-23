import { describe, expect, it } from "vitest";
import {
  openAIDoneLine,
  openAIFinalChunk,
  openAIReasoningDeltaChunk,
  openAITextDeltaChunk,
  openAIToolCallDeltaChunk,
} from "../src/streaming/openai-sse-writer.js";

const base = { id: "chatcmpl-1", created: 123, model: "Synesis" };

function payload(line: string): Record<string, unknown> {
  expect(line.endsWith("\n\n")).toBe(true);
  expect(line.startsWith("data: ")).toBe(true);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

describe("OpenAI SSE writer", () => {
  it("formats text delta chunks with OpenAI chunk shape", () => {
    const chunk = payload(openAITextDeltaChunk(base, "hello"));
    expect(chunk).toMatchObject({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 123,
      model: "Synesis",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });
  });

  it("formats reasoning delta chunks as reasoning_content extension", () => {
    const chunk = payload(openAIReasoningDeltaChunk(base, "thinking"));
    expect(chunk).toMatchObject({
      choices: [{ delta: { reasoning_content: "thinking" } }],
    });
  });

  it("formats tool-call deltas", () => {
    const chunk = payload(openAIToolCallDeltaChunk(base, {
      index: 0,
      id: "tc1",
      type: "function",
      function: { name: "Bash", arguments: "{\"command\":\"npm test\"}" },
    }));
    expect(chunk).toMatchObject({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "tc1",
            type: "function",
            function: { name: "Bash", arguments: "{\"command\":\"npm test\"}" },
          }],
        },
        finish_reason: null,
      }],
    });
  });

  it("formats final chunks with optional usage and done sentinel", () => {
    const chunk = payload(openAIFinalChunk(base, "stop", { total_tokens: 3 }));
    expect(chunk).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
    expect(openAIDoneLine()).toBe("data: [DONE]\n\n");
  });
});
