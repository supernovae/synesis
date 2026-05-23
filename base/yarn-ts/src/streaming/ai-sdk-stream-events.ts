export type AiSdkStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_start"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_end" }
  | { type: "tool_input_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_input_delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; finishReason: unknown }
  | { type: "error"; error: unknown }
  | { type: "unknown"; rawType: string | undefined };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function classifyAiSdkStreamPart(part: unknown): AiSdkStreamEvent {
  const record = asRecord(part);
  const rawType = typeof record.type === "string" ? record.type : undefined;

  switch (rawType) {
    case "text-delta":
      return { type: "text_delta", text: stringField(record.text) };
    case "reasoning-start":
      return { type: "reasoning_start", text: stringField(record.text) };
    case "reasoning-delta":
      return { type: "reasoning_delta", text: stringField(record.textDelta) || stringField(record.text) };
    case "reasoning-end":
      return { type: "reasoning_end" };
    case "tool-input-start":
      return {
        type: "tool_input_start",
        toolCallId: stringField(record.toolCallId),
        toolName: stringField(record.toolName),
        input: record.input,
      };
    case "tool-input-delta":
      return {
        type: "tool_input_delta",
        toolCallId: stringField(record.toolCallId),
        inputTextDelta: stringField(record.inputTextDelta),
      };
    case "tool-call":
      return {
        type: "tool_call",
        toolCallId: stringField(record.toolCallId),
        toolName: stringField(record.toolName),
        input: record.input,
      };
    case "finish":
      return { type: "finish", finishReason: record.finishReason };
    case "error":
      return { type: "error", error: record.error };
    default:
      return { type: "unknown", rawType };
  }
}

export function serializeToolInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

export function parseToolInput(input: unknown, normalizedArgs: string): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(normalizedArgs) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
