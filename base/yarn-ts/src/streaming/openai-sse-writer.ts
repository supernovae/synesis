export interface OpenAIChunkBase {
  id: string;
  created: number;
  model: string;
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function: {
    name?: string;
    arguments?: string;
  };
}

export function sseDataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function openAIDoneLine(): string {
  return "data: [DONE]\n\n";
}

export function openAITextDeltaChunk(base: OpenAIChunkBase, content: string): string {
  return sseDataLine({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

export function openAIReasoningDeltaChunk(base: OpenAIChunkBase, reasoningContent: string): string {
  return sseDataLine({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }],
  });
}

export function openAIToolCallDeltaChunk(base: OpenAIChunkBase, toolCall: OpenAIToolCallDelta): string {
  return sseDataLine({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
  });
}

export function openAIFinalChunk(
  base: OpenAIChunkBase,
  finishReason: string,
  usage?: unknown,
): string {
  const payload: Record<string, unknown> = {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (usage !== undefined) payload.usage = usage;
  return sseDataLine(payload);
}
