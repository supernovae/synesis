export interface BuildAiSdkTextRequestOptionsInput {
  model: unknown;
  messages: unknown;
  maxOutputTokens: number;
  samplingOptions?: Record<string, unknown>;
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  output?: unknown;
  stopSequences?: unknown;
  abortSignal?: AbortSignal;
}

export type AiSdkTextRequestOptions = Record<string, unknown>;

export function buildAiSdkTextRequestOptions(
  input: BuildAiSdkTextRequestOptionsInput,
): AiSdkTextRequestOptions {
  const options: AiSdkTextRequestOptions = {
    model: input.model,
    messages: input.messages,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.samplingOptions ?? {}),
  };

  if (input.abortSignal) options.abortSignal = input.abortSignal;
  if (input.output) options.output = input.output;
  if (input.stopSequences) options.stopSequences = input.stopSequences;
  if (input.tools) options.tools = input.tools;
  if (input.toolChoice) options.toolChoice = input.toolChoice;
  if (input.providerOptions) options.providerOptions = input.providerOptions;
  return options;
}
