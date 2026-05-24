import {
  buildAiSdkTextRequestOptions,
  type AiSdkTextRequestOptions,
} from "../providers/ai-sdk-request-options.js";

export interface OpenAIStreamProviderRequestInput {
  model: unknown;
  messages: unknown;
  abortSignal: AbortSignal;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  requestMaxCompletionTokens?: number | null;
  output?: unknown;
  samplingOptions?: Record<string, unknown>;
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  clampMaxOutputTokens(tokens: number): number;
}

export function createOpenAIStreamProviderRequestOptions(
  input: OpenAIStreamProviderRequestInput,
): AiSdkTextRequestOptions {
  const requestedMaxTokens = input.requestMaxTokens ?? input.requestMaxCompletionTokens ?? 0;
  return buildAiSdkTextRequestOptions({
    model: input.model,
    messages: input.messages,
    abortSignal: input.abortSignal,
    maxOutputTokens: input.clampMaxOutputTokens(
      Math.max(input.orchestrationMaxOutputTokens, requestedMaxTokens),
    ),
    output: input.output,
    samplingOptions: input.samplingOptions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
  });
}
