export interface AnthropicChunk {
  type?: string;
  delta?: { text?: string };
  content_block?: { text?: string };
}

export function extractAnthropicTextChunk(chunk: AnthropicChunk): string {
  if (!chunk || typeof chunk !== "object") return "";
  if (typeof chunk.delta?.text === "string") return chunk.delta.text;
  if (typeof chunk.content_block?.text === "string") return chunk.content_block.text;
  return "";
}

export function normalizeAnthropicStopReason(reason: string | null | undefined): string {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r) return "unknown";
  if (r === "end_turn" || r === "stop_sequence") return "stop";
  if (r === "tool_use") return "tool_call";
  if (r === "max_tokens") return "length";
  return r;
}
