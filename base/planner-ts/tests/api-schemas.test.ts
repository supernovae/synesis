import { describe, expect, it } from "vitest";
import { ChatCompletionRequestSchema } from "../src/api-schemas.js";

describe("planner API schemas", () => {
  it("accepts known chat completion payloads", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [
        { role: "developer", content: "Follow policy." },
        { role: "user", content: "Plan this task." },
      ],
      stream_options: { include_usage: true },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "plan",
          schema: { type: "object", properties: { answer: { type: "string" } } },
          strict: true,
        },
      },
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "search" } },
      modalities: ["text", "audio"],
      prediction: { type: "content", content: [{ type: "text", text: "Known output prefix" }] },
      audio: { voice: "alloy", format: "mp3" },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.messages[0]?.role).toBe("system");
  });

  it("rejects unknown top-level request fields", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      role_override: "platform_admin",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown message and tool fields", () => {
    const message = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task.", security_override: true }],
    });
    expect(message.success).toBe(false);

    const tool = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tools: [
        {
          type: "function",
          function: { name: "search", parameters: { type: "object" }, security_override: true },
        },
      ],
    });
    expect(tool.success).toBe(false);
  });

  it("accepts known multipart message content and rejects invented content attributes", () => {
    const accepted = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Plan this task." },
            { type: "image_url", image_url: { url: "https://example.test/diagram.png" } },
          ],
        },
      ],
    });
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(accepted.data.messages[0]?.content).toBe("Plan this task.");
    }

    const rejected = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan this task.", run_as_admin: true }],
        },
      ],
    });
    expect(rejected.success).toBe(false);
  });

  it("rejects unknown tool_choice envelope fields", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tool_choice: { type: "function", function: { name: "search" }, role_override: "admin" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invented JSON Schema attributes in tool and response schemas", () => {
    const tool = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object", properties: { query: { type: "string", role_override: "admin" } } },
          },
        },
      ],
    });
    expect(tool.success).toBe(false);

    const responseFormat = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", security_context: { role: "admin" } },
        },
      },
    });
    expect(responseFormat.success).toBe(false);
  });

  it("rejects invented prediction and audio attributes", () => {
    const prediction = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      prediction: {
        type: "content",
        content: "Known output prefix",
        run_as_role: "admin",
      },
    });
    expect(prediction.success).toBe(false);

    const audio = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      audio: {
        voice: "alloy",
        format: "mp3",
        credential_env: "OPENAI_API_KEY",
      },
    });
    expect(audio.success).toBe(false);
  });
});
