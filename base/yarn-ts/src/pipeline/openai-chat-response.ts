import { toOpenAiUsage } from "../openai-compat.js";
import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";

export interface OpenAIChatCompletionResponseInput {
  id: string;
  model: string;
  message: Record<string, unknown>;
  finishReason: string;
  usage: StreamTokenUsage;
  created?: number;
}

export function buildOpenAIChatCompletionResponse(input: OpenAIChatCompletionResponseInput): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [{ index: 0, message: input.message, finish_reason: input.finishReason }],
    usage: toOpenAiUsage(input.usage),
  };
}
