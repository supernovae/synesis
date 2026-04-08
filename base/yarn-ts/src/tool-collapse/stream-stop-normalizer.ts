export function normalizeOpenAIStreamFinishReason(
  finishReason: string,
  emittedToolCalls: number,
): string {
  if (finishReason === "tool_calls" && emittedToolCalls <= 0) {
    return "stop";
  }
  return finishReason;
}

export function normalizeClaudeStreamStopReason(
  stopReason: string,
  emittedToolCalls: number,
): string {
  if (stopReason === "tool_use" && emittedToolCalls <= 0) {
    return "end_turn";
  }
  return stopReason;
}
