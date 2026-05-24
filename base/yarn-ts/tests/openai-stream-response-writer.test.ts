import { describe, expect, it } from "vitest";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";

function createWriter() {
  const writes: string[] = [];
  const raw = { destroyed: false, write: (data: string) => { writes.push(data); } } as NodeJS.WritableStream & { destroyed?: boolean };
  const writer = new OpenAIStreamResponseWriter({
    raw,
    requestId: "chatcmpl_test",
    model: "test-model",
  });
  return { writer, writes, raw };
}

describe("OpenAIStreamResponseWriter", () => {
  it("writes text and reasoning deltas with OpenAI-compatible SSE shape", () => {
    const { writer, writes } = createWriter();

    expect(writer.writeTextDelta("hello")).toBe(true);
    expect(writer.writeReasoningDelta("thinking")).toBe(true);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("\"content\":\"hello\"");
    expect(writes[1]).toContain("\"reasoning_content\":\"thinking\"");
  });

  it("writes tool-call deltas using the supplied created timestamp", () => {
    const { writer, writes } = createWriter();

    writer.writeToolCallDelta({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
    }, 123);

    expect(writes[0]).toContain("\"created\":123");
    expect(writes[0]).toContain("\"tool_calls\"");
    expect(writes[0]).toContain("\"name\":\"Bash\"");
  });

  it("writes final chunk and done line", () => {
    const { writer, writes } = createWriter();

    writer.writeFinalChunk("stop", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    writer.writeDoneLine();

    expect(writes[0]).toContain("\"finish_reason\":\"stop\"");
    expect(writes[0]).toContain("\"usage\"");
    expect(writes[1]).toBe("data: [DONE]\n\n");
  });

  it("does not write empty text deltas or destroyed streams", () => {
    const { writer, writes, raw } = createWriter();

    expect(writer.writeTextDelta("")).toBe(false);
    raw.destroyed = true;
    expect(writer.writeTextDelta("ignored")).toBe(false);

    expect(writes).toEqual([]);
  });
});
