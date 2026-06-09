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

  it("restricts Synesis planner controls to known modes and aliases", () => {
    const accepted = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      metadata: {
        synesis_context_mediation: "hands-off",
        synesis_architecture_mediation: "assertive",
        architecture_mediation: "observe",
        synesis_architecture_profile: "model-registry",
        synesis: {
          contextMediation: "safe",
          architectureProfile: "auto",
        },
      },
    });
    expect(accepted.success).toBe(true);

    const inventedMediation = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      metadata: {
        synesis_context_mediation: "role=admin",
      },
    });
    expect(inventedMediation.success).toBe(false);

    const inventedNestedMediation = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      metadata: {
        synesis: {
          contextMediation: "security_override",
        },
      },
    });
    expect(inventedNestedMediation.success).toBe(false);

    const inventedProfile = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      metadata: {
        synesis_architecture_profile: "read-secrets",
      },
    });
    expect(inventedProfile.success).toBe(false);
  });

  it("rejects invented provider option enum values", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      reasoning_effort: "platform_admin",
      service_tier: "root",
    });

    expect(parsed.success).toBe(false);
  });

  it("bounds provider identity, resource controls, and provider extra body", () => {
    const oversized = "x".repeat(257);
    const identity = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      user: oversized,
    });
    expect(identity.success).toBe(false);

    const oversizedStop = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      stop: Array.from({ length: 17 }, (_, i) => `stop-${i}`),
    });
    expect(oversizedStop.success).toBe(false);

    const unsafeSampling = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      max_completion_tokens: 2_000_001,
      temperature: 3,
      top_p: 1.5,
      min_p: -0.1,
      presence_penalty: -3,
      top_logprobs: 21,
      n: 0,
      modalities: ["text", "admin"],
    });
    expect(unsafeSampling.success).toBe(false);

    const invalidLogitBias = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      logit_bias: { "123": 101 },
    });
    expect(invalidLogitBias.success).toBe(false);

    const invalidExtraBody = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      extra_body: { top_k: 1_000_001, repetition_penalty: 11 },
    });
    expect(invalidExtraBody.success).toBe(false);
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

  it("rejects unknown tool call function fields", () => {
    const parsed = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "search",
                arguments: "{\"query\":\"policy\"}",
                role_override: "platform_admin",
              },
            },
          ],
        },
      ],
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

  it("rejects free-form and semantically invalid JSON Schema descriptors", () => {
    const emptyToolSchema = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object", properties: { query: {} } },
          },
        },
      ],
    });
    expect(emptyToolSchema.success).toBe(false);

    const freeFormObject = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object", properties: {}, additionalProperties: true },
          },
        },
      ],
    });
    expect(freeFormObject.success).toBe(false);

    const invalidRequired = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["admin_only"] },
        },
      },
    });
    expect(invalidRequired.success).toBe(false);

    const wrongTypeConstraint = ChatCompletionRequestSchema.safeParse({
      model: "Synesis",
      messages: [{ role: "user", content: "Plan this task." }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "string", items: { type: "string" } },
        },
      },
    });
    expect(wrongTypeConstraint.success).toBe(false);
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
