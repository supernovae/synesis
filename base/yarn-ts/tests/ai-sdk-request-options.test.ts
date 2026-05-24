import { describe, expect, it } from "vitest";
import { buildAiSdkTextRequestOptions } from "../src/providers/ai-sdk-request-options.js";

describe("AI SDK request option builder", () => {
  it("builds the shared provider request shape and omits absent optional fields", () => {
    const options = buildAiSdkTextRequestOptions({
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 512,
      samplingOptions: { temperature: 0.2, topP: 0.9 },
    });

    expect(options).toEqual({
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 512,
      temperature: 0.2,
      topP: 0.9,
    });
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("providerOptions");
  });

  it("includes streaming, structured-output, tools, stop, and provider options when present", () => {
    const abortController = new AbortController();
    const options = buildAiSdkTextRequestOptions({
      model: "model",
      messages: [],
      maxOutputTokens: 128,
      samplingOptions: { temperature: 0 },
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { openai: { reasoningEffort: "low" } },
      output: { type: "json" },
      stopSequences: ["stop"],
      abortSignal: abortController.signal,
    });

    expect(options).toMatchObject({
      model: "model",
      messages: [],
      maxOutputTokens: 128,
      temperature: 0,
      tools: { Bash: {} },
      toolChoice: "required",
      providerOptions: { openai: { reasoningEffort: "low" } },
      output: { type: "json" },
      stopSequences: ["stop"],
    });
    expect(options.abortSignal).toBe(abortController.signal);
  });
});
