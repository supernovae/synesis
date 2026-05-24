import {
  buildAiSdkTextRequestOptions,
  type AiSdkTextRequestOptions,
} from "../providers/ai-sdk-request-options.js";

export interface ClaudeStreamProviderRequestInput {
  model: unknown;
  messages: unknown;
  abortSignal: AbortSignal;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  clampMaxOutputTokens(tokens: number): number;
}

export function createClaudeStreamProviderRequestOptions(
  input: ClaudeStreamProviderRequestInput,
): AiSdkTextRequestOptions {
  return buildAiSdkTextRequestOptions({
    model: input.model,
    messages: input.messages,
    abortSignal: input.abortSignal,
    maxOutputTokens: input.clampMaxOutputTokens(
      Math.max(input.orchestrationMaxOutputTokens, input.requestMaxTokens ?? 0),
    ),
    samplingOptions: input.samplingOptions,
    stopSequences: input.stopSequences,
    tools: input.tools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
  });
}
