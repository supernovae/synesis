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

  it("rejects unknown tool_choice envelope fields", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tool_choice: { type: "function", function: { name: "search" }, role_override: "admin" },
    });

    expect(parsed.success).toBe(false);
  });
});
