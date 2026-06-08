import { describe, expect, it } from "vitest";
import {
  chatCompletionToResponseObject,
  OpenAIResponsesRequestSchema,
  responseObjectToSseEvents,
  responsesRequestToChatCompletion,
} from "../src/responses-compat.js";

describe("OpenAI Responses API compatibility", () => {
  it("maps Responses input, tools, JSON format, and reasoning to Chat Completions", () => {
    const parsed = OpenAIResponsesRequestSchema.safeParse({
      model: "synesis-yarn",
      instructions: "You are concise.",
      input: [
        { role: "developer", content: "Prefer JSON." },
        { role: "user", content: [{ type: "input_text", text: "Return status." }] },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: { id: { type: "string" } } },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      text: {
        format: {
          type: "json_schema",
          name: "status_result",
          strict: true,
          schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
        },
      },
      reasoning: { effort: "low" },
      max_output_tokens: 123,
      parallel_tool_calls: false,
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      safety_identifier: "safe-user",
      verbosity: "low",
      metadata: { session: "abc" },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const chat = responsesRequestToChatCompletion(parsed.data);
    expect(chat.messages[0]).toEqual({ role: "system", content: "You are concise." });
    expect(chat.messages[1]?.role).toBe("system");
    expect(chat.messages[2]?.content).toEqual([{ type: "text", text: "Return status." }]);
    expect(chat.max_completion_tokens).toBe(123);
    expect(chat.reasoning_effort).toBe("low");
    expect(chat.parallel_tool_calls).toBe(false);
    expect(chat.prompt_cache_key).toBe("cache-key");
    expect(chat.prompt_cache_retention).toBe("24h");
    expect(chat.safety_identifier).toBe("safe-user");
    expect(chat.verbosity).toBe("low");
    expect(chat.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "lookup", strict: true },
    });
    expect(chat.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(chat.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "status_result", strict: true },
    });
  });

  it("maps function call outputs into tool messages", () => {
    const parsed = OpenAIResponsesRequestSchema.parse({
      model: "synesis-yarn",
      input: [
        { type: "function_call_output", call_id: "call_123", output: { ok: true } },
      ],
    });
    const chat = responsesRequestToChatCompletion(parsed);
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "call_123", content: "{\"ok\":true}" },
    ]);
  });

  it("rejects unknown top-level Responses request fields", () => {
    const parsed = OpenAIResponsesRequestSchema.safeParse({
      model: "synesis-yarn",
      input: "hi",
      role_override: "admin",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown Responses message and tool fields", () => {
    const parsed = OpenAIResponsesRequestSchema.safeParse({
      model: "synesis-yarn",
      input: [
        {
          role: "user",
          content: "hi",
          security_context: { role: "admin" },
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
          role_override: "admin",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown Responses tool choice and text format fields", () => {
    const parsed = OpenAIResponsesRequestSchema.safeParse({
      model: "synesis-yarn",
      input: "hi",
      tool_choice: { type: "function", name: "lookup", role_override: "admin" },
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object" },
          injected_attribute: true,
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("maps Chat Completions output into Responses objects and SSE events", () => {
    const response = chatCompletionToResponseObject({
      id: "chatcmpl_1",
      created: 1704067200,
      model: "synesis-yarn",
      choices: [{
        message: {
          role: "assistant",
          content: "Done",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":\"1\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }, {
      model: "synesis-yarn",
      input: "hello",
      stream: false,
      metadata: { trace: "t1" },
    });

    expect(response.object).toBe("response");
    expect(response.output_text).toBe("Done");
    expect(response.output.some((item) => item.type === "function_call")).toBe(true);
    expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    expect(response.metadata).toEqual({ trace: "t1" });

    const events = responseObjectToSseEvents(response);
    expect(events.map((event) => event.event)).toContain("response.output_text.delta");
    expect(events.at(-1)?.event).toBe("response.completed");
  });
});
