import { sdkToolCallsToClaude } from "../tool-mapping.js";

export interface ClaudeNonStreamResponseToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ClaudeNonStreamServerWebSearchEvent {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  query: string;
  results: Array<{ type: "web_search_result"; url: string; title: string; snippet: string }>;
  errorCode?: string;
}

export interface ClaudeNonStreamResponseInput {
  reasoning?: unknown;
  serverWebSearchEvents: ClaudeNonStreamServerWebSearchEvent[];
  finalText: string;
  toolCalls: ClaudeNonStreamResponseToolCall[];
}

export type ClaudeNonStreamResponseContentBlock = Record<string, unknown>;

export interface ClaudeNonStreamMessageResponseInput {
  id: string;
  model: string;
  content: ClaudeNonStreamResponseContentBlock[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ClaudeNonStreamMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ClaudeNonStreamResponseContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function buildClaudeNonStreamResponseContent(
  input: ClaudeNonStreamResponseInput,
): ClaudeNonStreamResponseContentBlock[] {
  const content: ClaudeNonStreamResponseContentBlock[] = [];
  if (input.reasoning) {
    content.push({ type: "thinking", thinking: input.reasoning });
  }

  for (const event of input.serverWebSearchEvents) {
    content.push({
      type: "server_tool_use",
      id: event.toolUseId,
      name: event.toolName,
      input: event.input,
    });
    content.push({
      type: "web_search_tool_result",
      tool_use_id: event.toolUseId,
      content: event.errorCode
        ? {
            type: "web_search_tool_result_error",
            error_code: event.errorCode,
          }
        : event.results,
    });
  }

  if (input.finalText) {
    content.push({ type: "text", text: input.finalText });
  }

  for (const toolCall of sdkToolCallsToClaude(input.toolCalls)) {
    content.push({ ...toolCall });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return content;
}

export function buildClaudeNonStreamMessageResponse(
  input: ClaudeNonStreamMessageResponseInput,
): ClaudeNonStreamMessageResponse {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.model,
    content: input.content,
    stop_reason: input.stopReason,
    usage: {
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
    },
  };
}
