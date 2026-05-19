import { describe, expect, it } from "vitest";
import { OpenAIChatCompletionRequestSchema, ClaudeMessagesRequestSchema } from "../src/schemas.js";
import { OpenAIResponsesRequestSchema, responsesRequestToChatCompletion } from "../src/responses-compat.js";
import { normalizeToolDescriptions, TOOL_DESCRIPTION_MAX_CHARS } from "../src/compat/tool-description-normalizer.js";

describe("tool description normalization", () => {
  const longDescription = "x".repeat(TOOL_DESCRIPTION_MAX_CHARS + 100);

  it("truncates OpenAI function tool descriptions before schema validation", () => {
    const normalized = normalizeToolDescriptions({
      model: "synesis-yarn",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "Read",
          description: longDescription,
          parameters: { type: "object" },
        },
      }],
    }, "openai", "/v1/chat/completions");

    expect(normalized.truncations).toHaveLength(1);
    expect(normalized.truncations[0]).toMatchObject({
      endpoint: "/v1/chat/completions",
      path: "tools.0.function.description",
      toolName: "Read",
      originalLength: longDescription.length,
      maxLength: TOOL_DESCRIPTION_MAX_CHARS,
    });
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(normalized.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tools?.[0]?.function.description).toHaveLength(TOOL_DESCRIPTION_MAX_CHARS);
  });

  it("truncates Claude tool descriptions before schema validation", () => {
    const normalized = normalizeToolDescriptions({
      model: "synesis-yarn",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        name: "Read",
        description: longDescription,
        input_schema: { type: "object" },
      }],
    }, "claude", "/v1/messages");

    expect(normalized.truncations).toHaveLength(1);
    const parsed = ClaudeMessagesRequestSchema.safeParse(normalized.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tools?.[0]?.description).toHaveLength(TOOL_DESCRIPTION_MAX_CHARS);
  });

  it("normalizes Responses tools before converting to Chat Completions", () => {
    const parsed = OpenAIResponsesRequestSchema.parse({
      model: "synesis-yarn",
      input: "hi",
      tools: [{
        type: "function",
        name: "lookup",
        description: longDescription,
        parameters: { type: "object" },
      }],
    });

    const chat = responsesRequestToChatCompletion(parsed);
    expect(chat.tools?.[0]?.function.name).toBe("lookup");
    expect(chat.tools?.[0]?.function.description).toHaveLength(TOOL_DESCRIPTION_MAX_CHARS);
  });

  it("normalizes OpenAI-shaped Responses tools before converting to Chat Completions", () => {
    const parsed = OpenAIResponsesRequestSchema.parse({
      model: "synesis-yarn",
      input: "hi",
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: longDescription,
          parameters: { type: "object" },
        },
      }],
    });

    const chat = responsesRequestToChatCompletion(parsed);
    expect(chat.tools?.[0]?.function.name).toBe("lookup");
    expect(chat.tools?.[0]?.function.description).toHaveLength(TOOL_DESCRIPTION_MAX_CHARS);
  });
});
