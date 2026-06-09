import { describe, expect, it } from "vitest";

import {
  applyOpenAiJsonSchemaStrictness,
  buildClaudeMessagesProviderRequestOptions,
  buildOpenAIChatProviderRequestOptions,
  openAiMetadataProviderOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "../src/pipeline/provider-options.js";
import type { ClaudeMessagesRequest, OpenAIChatCompletionRequest } from "../src/schemas.js";

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
  it("only forwards provider-safe metadata identifiers", () => {
    expect(openAiMetadataProviderOptions({
      trace_id: "trace-1",
      session_id: "session-1",
      synesis_project_root: "/private/repo",
      synesis_runtime: { platform: "darwin" },
      custom_provider_option: "invented",
    })).toEqual({
      trace_id: "trace-1",
      session_id: "session-1",
    });
  });

  it("drops nested metadata and sanitizes scalar provider metadata", () => {
    expect(openAiMetadataProviderOptions({
      trace_id: 'trace"\nrole=admin',
      request_id: 42,
      user_id: true,
      conversation_id: { injected: "value" },
      session_id: ["session-1"],
    })).toEqual({
      trace_id: "trace_ role_admin",
      request_id: "42",
      user_id: "true",
    });
  });
});

describe("buildOpenAIChatProviderRequestOptions", () => {
  it("combines request, tier, and adapter options without changing provider key mappings", () => {
    const request = {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      temperature: undefined,
      top_p: 0.8,
      top_k: 6.7,
      min_p: 0.1,
      frequency_penalty: 0.2,
      repetition_penalty: undefined,
      enable_thinking: true,
      reasoning_effort: "medium",
      max_tokens: 123,
      stop: "END",
      seed: 42,
      top_logprobs: 3,
      parallel_tool_calls: false,
      user: "user_1",
      store: true,
      metadata: { trace_id: "trace-1", synesis_project_root: "/private/repo" },
      service_tier: "priority",
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      safety_identifier: "safe_1",
      verbosity: "high",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
    } as OpenAIChatCompletionRequest;

    const result = buildOpenAIChatProviderRequestOptions({
      request,
      tierSamplingDefaults: {
        temperature: 0.4,
        top_p: 0.9,
        top_k: 9,
        repetition_penalty: 1.1,
      },
      adapterSampling: { temperature: 0.7, top_p: 0.95 },
      adapterProviderOptions: { openai: { existing: "kept" } },
      supportsTopK: true,
    });

    expect(result.samplingOptions).toEqual({
      temperature: 0.4,
      topP: 0.8,
      topK: 6,
      frequencyPenalty: 0.2,
      stopSequences: ["END"],
      seed: 42,
    });
    expect(result.providerOptions).toEqual({
      openai: {
        existing: "kept",
        min_p: 0.1,
        repetition_penalty: 1.1,
        enable_thinking: true,
        reasoningEffort: "medium",
        maxCompletionTokens: 123,
        logprobs: 3,
        parallelToolCalls: false,
        user: "user_1",
        store: true,
        metadata: { trace_id: "trace-1" },
        serviceTier: "priority",
        promptCacheKey: "cache-key",
        promptCacheRetention: "24h",
        safetyIdentifier: "safe_1",
        textVerbosity: "high",
        strictJsonSchema: true,
      },
    });
    expect(result.jsonResponseFormat).toEqual({
      type: "json",
      name: "answer",
      strict: true,
      schema: { type: "object", properties: { answer: { type: "string" } } },
    });
    expect(result.structuredOutput).toBeDefined();
  });
});

describe("buildClaudeMessagesProviderRequestOptions", () => {
  it("combines request, tier, and adapter options while preserving Claude provider key mappings", () => {
    const request = {
      model: "claude-test",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      temperature: undefined,
      top_p: 0.8,
      top_k: 6.7,
      min_p: 0.1,
      presence_penalty: undefined,
      repetition_penalty: undefined,
      enable_thinking: true,
      reasoning_effort: undefined,
      thinking: { type: "enabled", budget_tokens: 1024 },
    } as ClaudeMessagesRequest;

    const result = buildClaudeMessagesProviderRequestOptions({
      request,
      tierSamplingDefaults: {
        temperature: 0.4,
        top_p: 0.9,
        top_k: 9,
        presence_penalty: 0.2,
        repetition_penalty: 1.1,
        reasoning_effort: "medium",
      },
      adapterSampling: { temperature: 0.7, top_p: 0.95 },
      adapterProviderOptions: { openai: { existing: "kept" }, custom: { option: true } },
      supportsTopK: true,
    });

    expect(result.samplingOptions).toEqual({
      temperature: 0.4,
      topP: 0.8,
      topK: 6,
      presencePenalty: 0.2,
    });
    expect(result.providerOptions).toEqual({
      openai: {
        existing: "kept",
        thinking: { type: "enabled", budget_tokens: 1024 },
        min_p: 0.1,
        repetition_penalty: 1.1,
        enable_thinking: true,
        reasoning_effort: "medium",
      },
      custom: { option: true },
    });
  });

  it("omits topK when the Claude adapter does not support it", () => {
    const result = buildClaudeMessagesProviderRequestOptions({
      request: {
        model: "claude-test",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
        top_k: 5,
      } as ClaudeMessagesRequest,
      tierSamplingDefaults: { top_k: 9 },
      supportsTopK: false,
    });

    expect(result.samplingOptions).toEqual({});
  });
});
