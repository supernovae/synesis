import { describe, expect, it } from "vitest";
import { buildOpenAINonStreamAssistantMessage } from "../src/pipeline/openai-nonstream-response-message.js";

describe("buildOpenAINonStreamAssistantMessage", () => {
  it("includes text and reasoning without empty tool calls", () => {
    expect(buildOpenAINonStreamAssistantMessage({
      finalText: "done",
      reasoning: "thinking",
      toolCalls: [],
      effectiveTools: [],
      clientKind: "opencode",
    })).toEqual({
      role: "assistant",
      content: "done",
      reasoning_content: "thinking",
    });
  });

  it("restores and serializes tool calls for OpenAI responses", () => {
    const message = buildOpenAINonStreamAssistantMessage({
      finalText: "",
      toolCalls: [
        { toolCallId: "call_1", toolName: "Read", input: { file_path: "src/index.ts" } },
      ],
      effectiveTools: [
        {
          type: "function",
          function: {
            name: "Read",
            parameters: {
              type: "object",
              properties: {
                file_path: { type: "string" },
              },
            },
          },
        },
      ],
      clientKind: "opencode",
    });

    expect(message).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "Read",
          arguments: JSON.stringify({ file_path: "src/index.ts" }),
        },
      }],
    });
  });
});
