import { describe, expect, it } from "vitest";
import { toAiSdkJsonResponseFormat, toOpenAiUsage } from "../src/openai-compat.js";

describe("toOpenAiUsage", () => {
  it("includes cache_creation_input_tokens under prompt_tokens_details when non-zero", () => {
    const u = toOpenAiUsage({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 30,
      cacheCreationTokens: 40,
    });
    const details = u.prompt_tokens_details as Record<string, unknown>;
    expect(details.cached_tokens).toBe(30);
    expect(details.cache_creation_input_tokens).toBe(40);
    expect(u.cache_creation_tokens).toBe(40);
  });

  it("omits cache_creation_input_tokens in details when zero", () => {
    const u = toOpenAiUsage({
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    });
    const details = u.prompt_tokens_details as Record<string, unknown>;
    expect(details.cache_creation_input_tokens).toBeUndefined();
  });
});

describe("toAiSdkJsonResponseFormat", () => {
  it("maps OpenAI json_object response_format to AI SDK JSON mode", () => {
    expect(toAiSdkJsonResponseFormat({ type: "json_object" })).toEqual({ type: "json" });
  });

  it("maps OpenAI json_schema response_format to AI SDK JSON schema mode", () => {
    expect(toAiSdkJsonResponseFormat({
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "Structured answer",
        strict: false,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    })).toEqual({
      type: "json",
      name: "answer",
      description: "Structured answer",
      strict: false,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
  });

  it("leaves text and malformed response_format values unstructured", () => {
    expect(toAiSdkJsonResponseFormat({ type: "text" })).toBeUndefined();
    expect(toAiSdkJsonResponseFormat({ type: "json_schema", json_schema: { name: "missing_schema" } })).toBeUndefined();
  });
});
