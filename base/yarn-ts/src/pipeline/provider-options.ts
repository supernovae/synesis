import { jsonSchema, Output as aiOutput } from "ai";

import type { PhaseAwareToolChoice } from "../governance/phase-execution-policy.js";
import type { AiSdkJsonResponseFormat } from "../openai-compat.js";
import { toAiSdkJsonResponseFormat } from "../openai-compat.js";
import type { ModelSamplingDefaults } from "../providers/admin-tier-registry.js";
import type { ClaudeMessagesRequest, OpenAIChatCompletionRequest } from "../schemas.js";

export interface OpenAIChatProviderRequestOptionsInput {
  request: OpenAIChatCompletionRequest;
  tierSamplingDefaults?: ModelSamplingDefaults;
  adapterSampling?: { temperature?: number; top_p?: number };
  adapterProviderOptions?: Record<string, Record<string, unknown>>;
  supportsTopK: boolean;
}

export interface OpenAIChatProviderRequestOptions {
  samplingOptions: Record<string, unknown>;
  providerOptions?: Record<string, Record<string, unknown>>;
  jsonResponseFormat?: AiSdkJsonResponseFormat;
  structuredOutput: ReturnType<typeof buildOpenAiJsonOutput>;
}

export interface ClaudeMessagesProviderRequestOptionsInput {
  request: Pick<
    ClaudeMessagesRequest,
    | "temperature"
    | "top_p"
    | "top_k"
    | "min_p"
    | "presence_penalty"
    | "repetition_penalty"
    | "enable_thinking"
    | "reasoning_effort"
    | "thinking"
  >;
  tierSamplingDefaults?: ModelSamplingDefaults;
  adapterSampling?: { temperature?: number; top_p?: number };
  adapterProviderOptions?: Record<string, Record<string, unknown>>;
  supportsTopK: boolean;
}

export interface ClaudeMessagesProviderRequestOptions {
  samplingOptions: Record<string, unknown>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export function buildClaudeMessagesProviderRequestOptions(
  input: ClaudeMessagesProviderRequestOptionsInput,
): ClaudeMessagesProviderRequestOptions {
  const { request, tierSamplingDefaults, adapterSampling, adapterProviderOptions, supportsTopK } = input;
  const effectiveTemp = request.temperature ?? tierSamplingDefaults?.temperature ?? adapterSampling?.temperature;
  const effectiveTopP = request.top_p ?? tierSamplingDefaults?.top_p ?? adapterSampling?.top_p;
  const effectiveTopK = supportsTopK ? (request.top_k ?? tierSamplingDefaults?.top_k) : undefined;
  const effectivePresencePenalty = request.presence_penalty ?? tierSamplingDefaults?.presence_penalty;
  const effectiveMinP = request.min_p ?? tierSamplingDefaults?.min_p;
  const effectiveRepetitionPenalty = request.repetition_penalty ?? tierSamplingDefaults?.repetition_penalty;
  const effectiveEnableThinking = request.enable_thinking ?? tierSamplingDefaults?.enable_thinking;
  const effectiveReasoningEffort = request.reasoning_effort ?? tierSamplingDefaults?.reasoning_effort;
  const samplingOptions = {
    ...(effectiveTemp !== undefined ? { temperature: effectiveTemp } : {}),
    ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
    ...(effectiveTopK !== undefined ? { topK: Math.max(0, Math.trunc(effectiveTopK)) } : {}),
    ...(effectivePresencePenalty !== undefined ? { presencePenalty: effectivePresencePenalty } : {}),
  };
  const openAiOverrides = {
    ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    ...(effectiveMinP !== undefined ? { min_p: effectiveMinP } : {}),
    ...(effectiveRepetitionPenalty !== undefined ? { repetition_penalty: effectiveRepetitionPenalty } : {}),
    ...(effectiveEnableThinking !== undefined ? { enable_thinking: effectiveEnableThinking } : {}),
    ...(effectiveReasoningEffort !== undefined ? { reasoning_effort: effectiveReasoningEffort } : {}),
  };
  const providerOptions = Object.keys(openAiOverrides).length
    ? {
        ...(adapterProviderOptions ?? {}),
        openai: {
          ...((adapterProviderOptions?.openai ?? {}) as Record<string, unknown>),
          ...openAiOverrides,
        },
      }
    : adapterProviderOptions;
  return { samplingOptions, providerOptions };
}

export function buildOpenAIChatProviderRequestOptions(
  input: OpenAIChatProviderRequestOptionsInput,
): OpenAIChatProviderRequestOptions {
  const { request, tierSamplingDefaults, adapterSampling, adapterProviderOptions, supportsTopK } = input;
  const effectiveTemp = request.temperature ?? tierSamplingDefaults?.temperature ?? adapterSampling?.temperature;
  const effectiveTopP = request.top_p ?? tierSamplingDefaults?.top_p ?? adapterSampling?.top_p;
  const effectiveTopK = supportsTopK ? (request.top_k ?? tierSamplingDefaults?.top_k) : undefined;
  const effectiveMinP = request.min_p ?? tierSamplingDefaults?.min_p;
  const effectivePresencePenalty = request.presence_penalty ?? tierSamplingDefaults?.presence_penalty;
  const effectiveFrequencyPenalty = request.frequency_penalty;
  const effectiveRepetitionPenalty = request.repetition_penalty ?? tierSamplingDefaults?.repetition_penalty;
  const effectiveEnableThinking = request.enable_thinking ?? tierSamplingDefaults?.enable_thinking;
  const effectiveReasoningEffort = request.reasoning_effort ?? tierSamplingDefaults?.reasoning_effort;
  const effectiveMaxCompletionTokens = request.max_completion_tokens ?? request.max_tokens;
  const effectiveLogprobs = typeof request.top_logprobs === "number"
    ? request.top_logprobs
    : request.logprobs;
  const metadataProviderOptions = openAiMetadataProviderOptions(request.metadata);
  const stopSequences = typeof request.stop === "string"
    ? [request.stop]
    : (Array.isArray(request.stop) ? request.stop : undefined);
  const samplingOptions = {
    ...(effectiveTemp !== undefined ? { temperature: effectiveTemp } : {}),
    ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
    ...(effectiveTopK !== undefined ? { topK: Math.max(0, Math.trunc(effectiveTopK)) } : {}),
    ...(effectivePresencePenalty !== undefined ? { presencePenalty: effectivePresencePenalty } : {}),
    ...(effectiveFrequencyPenalty !== undefined ? { frequencyPenalty: effectiveFrequencyPenalty } : {}),
    ...(stopSequences && stopSequences.length > 0 ? { stopSequences } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
  const openAiOverrides = {
    ...(effectiveMinP !== undefined ? { min_p: effectiveMinP } : {}),
    ...(effectiveRepetitionPenalty !== undefined ? { repetition_penalty: effectiveRepetitionPenalty } : {}),
    ...(effectiveEnableThinking !== undefined ? { enable_thinking: effectiveEnableThinking } : {}),
    ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
    ...(effectiveMaxCompletionTokens !== undefined ? { maxCompletionTokens: effectiveMaxCompletionTokens } : {}),
    ...(request.logit_bias !== undefined ? { logitBias: request.logit_bias } : {}),
    ...(effectiveLogprobs !== undefined ? { logprobs: effectiveLogprobs } : {}),
    ...(request.parallel_tool_calls !== undefined ? { parallelToolCalls: request.parallel_tool_calls } : {}),
    ...(request.user ? { user: request.user } : {}),
    ...(request.store !== undefined ? { store: request.store } : {}),
    ...(metadataProviderOptions ? { metadata: metadataProviderOptions } : {}),
    ...(request.prediction && typeof request.prediction === "object" && !Array.isArray(request.prediction)
      ? { prediction: request.prediction as Record<string, unknown> }
      : {}),
    ...(request.service_tier === "auto" || request.service_tier === "flex" || request.service_tier === "priority" || request.service_tier === "default"
      ? { serviceTier: request.service_tier }
      : {}),
    ...(request.prompt_cache_key ? { promptCacheKey: request.prompt_cache_key } : {}),
    ...(request.prompt_cache_retention === "in_memory" || request.prompt_cache_retention === "24h"
      ? { promptCacheRetention: request.prompt_cache_retention }
      : {}),
    ...(request.safety_identifier ? { safetyIdentifier: request.safety_identifier } : {}),
    ...(request.verbosity === "low" || request.verbosity === "medium" || request.verbosity === "high"
      ? { textVerbosity: request.verbosity }
      : {}),
  };
  const jsonResponseFormat = toAiSdkJsonResponseFormat(request.response_format);
  const structuredOutput = buildOpenAiJsonOutput(jsonResponseFormat);
  const mergedProviderOptions = Object.keys(openAiOverrides).length
    ? {
        ...(adapterProviderOptions ?? {}),
        openai: {
          ...((adapterProviderOptions?.openai ?? {}) as Record<string, unknown>),
          ...openAiOverrides,
        },
      }
    : adapterProviderOptions;
  const providerOptions = applyOpenAiJsonSchemaStrictness(mergedProviderOptions, jsonResponseFormat);
  return {
    samplingOptions,
    providerOptions,
    jsonResponseFormat,
    structuredOutput,
  };
}

export function suppressThinkingWhenRequiredToolChoice(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  toolChoice: PhaseAwareToolChoice | undefined,
): { providerOptions: Record<string, Record<string, unknown>> | undefined; suppressed: boolean } {
  if (toolChoice !== "required") {
    return { providerOptions, suppressed: false };
  }
  const openaiOptions = (providerOptions?.openai ?? {}) as Record<string, unknown>;
  const hasThinkingEnabled =
    Object.prototype.hasOwnProperty.call(openaiOptions, "thinking")
    || (Object.prototype.hasOwnProperty.call(openaiOptions, "enable_thinking")
      && openaiOptions.enable_thinking !== false);
  if (!hasThinkingEnabled) {
    return { providerOptions, suppressed: false };
  }
  const nextOpenaiOptions: Record<string, unknown> = {
    ...openaiOptions,
    enable_thinking: false,
  };
  delete nextOpenaiOptions.thinking;
  return {
    providerOptions: {
      ...(providerOptions ?? {}),
      openai: nextOpenaiOptions,
    },
    suppressed: true,
  };
}

export function buildOpenAiJsonOutput(format: AiSdkJsonResponseFormat | undefined) {
  if (!format) return undefined;
  if ("schema" in format) {
    return aiOutput.object({
      schema: jsonSchema(format.schema),
      ...(format.name ? { name: format.name } : {}),
      ...(format.description ? { description: format.description } : {}),
    });
  }
  return aiOutput.json();
}

export function applyOpenAiJsonSchemaStrictness(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  format: AiSdkJsonResponseFormat | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!format || !("strict" in format) || format.strict === undefined) return providerOptions;
  return {
    ...(providerOptions ?? {}),
    openai: {
      ...((providerOptions?.openai ?? {}) as Record<string, unknown>),
      strictJsonSchema: format.strict,
    },
  };
}

const OPENAI_PROVIDER_METADATA_KEYS = new Set([
  "session",
  "session_id",
  "conversation_id",
  "synesis_conversation_id",
  "thread_id",
  "chat_id",
  "trace",
  "trace_id",
  "request_id",
  "user_id",
]);

export function openAiMetadataProviderOptions(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata)
    .filter(([key]) => OPENAI_PROVIDER_METADATA_KEYS.has(key))
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)] as const)
    .filter(([, value]) => typeof value === "string" && value.length <= 512);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
