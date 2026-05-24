import { describe, expect, it } from "vitest";

import {
  applyOpenAiJsonSchemaStrictness,
  openAiMetadataProviderOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "../src/pipeline/provider-options.js";

describe("suppressThinkingWhenRequiredToolChoice", () => {
  it("leaves provider options untouched unless tool_choice is required", () => {
    const providerOptions = { openai: { thinking: { effort: "medium" } } };

    expect(suppressThinkingWhenRequiredToolChoice(providerOptions, "auto")).toEqual({
      providerOptions,
      suppressed: false,
    });
  });

  it("removes thinking and disables enable_thinking for required tool choice", () => {
    const result = suppressThinkingWhenRequiredToolChoice(
      { openai: { thinking: { effort: "medium" }, enable_thinking: true, other: "kept" } },
      "required",
    );

    expect(result).toEqual({
      providerOptions: { openai: { enable_thinking: false, other: "kept" } },
      suppressed: true,
    });
  });
});

describe("applyOpenAiJsonSchemaStrictness", () => {
  it("maps strict json_schema mode into provider options", () => {
    expect(applyOpenAiJsonSchemaStrictness(
      { openai: { serviceTier: "flex" } },
      { type: "json", schema: { type: "object" }, strict: true },
    )).toEqual({
      openai: { serviceTier: "flex", strictJsonSchema: true },
    });
  });
});

describe("openAiMetadataProviderOptions", () => {
  it("coerces compact metadata values and drops oversized entries", () => {
    expect(openAiMetadataProviderOptions({
      short: "value",
      object: { ok: true },
      ["x".repeat(65)]: "ignored",
      oversized: "x".repeat(513),
    })).toEqual({
      short: "value",
      object: "{\"ok\":true}",
    });
  });
});
