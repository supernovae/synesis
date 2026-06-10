import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  guardModelOutputText,
  type ModelOutputGuardEvent,
} from "../security/model-output-guard.js";
import type { ClaudeNonStreamServerWebSearchEvent } from "./claude-nonstream-response.js";
import {
  executeClaudeNonStreamProviderLoop,
  type ClaudeNonStreamProviderExecutorInput,
  type ClaudeNonStreamProviderMessage,
  type ClaudeNonStreamProviderResultLike,
  type ClaudeNonStreamProviderToolCall,
} from "./claude-nonstream-provider-executor.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface ClaudeStreamKickoffResponseWriter {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  sendSse(event: string, data: unknown): boolean;
  end(): void;
  createMessageId(): string;
}

export interface ClaudeStreamKickoffPipelineInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TForensics = unknown,
> {
  model: string;
  headers: Record<string, string>;
  providerInput: ClaudeNonStreamProviderExecutorInput<TMessage, TResult, TForensics>;
  response: ClaudeStreamKickoffResponseWriter;
  onAssistantText(text: string): void;
  onModelOutputGuardrail?(event: ModelOutputGuardEvent): void;
}

export interface ClaudeStreamKickoffPipelineResult {
  usage: StreamTokenUsage;
  stopReason: string;
  externalToolCalls: ClaudeNonStreamProviderToolCall[];
  requestForensicsDone?: RequestForensicsRecord;
}

export async function runClaudeStreamKickoffPipeline<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TForensics = unknown,
>(
  input: ClaudeStreamKickoffPipelineInput<TMessage, TResult, TForensics>,
): Promise<ClaudeStreamKickoffPipelineResult> {
  const providerResult = await executeClaudeNonStreamProviderLoop(input.providerInput);
  const usage = input.providerInput.readUsage(providerResult.result.usage);
  const finalText = guardModelOutputText(
    providerResult.result.text ?? "",
    "claude_stream_kickoff_output",
    input.onModelOutputGuardrail,
  ).text;
  const finalCalls = providerResult.result.toolCalls ?? [];
  const externalToolCalls = finalCalls.filter(
    (toolCall) => !input.providerInput.isServerWebSearchTool(toolCall.toolName),
  );
  const stopReason = externalToolCalls.length > 0 ? "tool_use" : "end_turn";

  emitClaudeStreamKickoffResponse({
    model: input.model,
    headers: input.headers,
    serverWebSearchEvents: providerResult.serverWebSearchEvents,
    finalText,
    externalToolCalls,
    usage,
    stopReason,
    response: input.response,
    onAssistantText: input.onAssistantText,
  });

  return {
    usage,
    stopReason,
    externalToolCalls,
    requestForensicsDone: providerResult.requestForensicsDone,
  };
}

interface ClaudeStreamKickoffResponseInput {
  model: string;
  headers: Record<string, string>;
  serverWebSearchEvents: ClaudeNonStreamServerWebSearchEvent[];
  finalText: string;
  externalToolCalls: ClaudeNonStreamProviderToolCall[];
  usage: StreamTokenUsage;
  stopReason: string;
  response: ClaudeStreamKickoffResponseWriter;
  onAssistantText(text: string): void;
}

function emitClaudeStreamKickoffResponse(input: ClaudeStreamKickoffResponseInput): void {
  let index = 0;
  input.response.writeHead(200, input.headers);
  input.response.sendSse("message_start", {
    type: "message_start",
    message: {
      id: input.response.createMessageId(),
      type: "message",
      role: "assistant",
      model: input.model,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  for (const event of input.serverWebSearchEvents) {
    input.response.sendSse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "server_tool_use",
        id: event.toolUseId,
        name: event.toolName,
        input: event.input,
      },
    });
    input.response.sendSse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    input.response.sendSse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: event.errorCode
        ? {
            type: "web_search_tool_result",
            tool_use_id: event.toolUseId,
            content: {
              type: "web_search_tool_result_error",
              error_code: event.errorCode,
            },
          }
        : {
            type: "web_search_tool_result",
            tool_use_id: event.toolUseId,
            content: event.results,
          },
    });
    input.response.sendSse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }

  if (input.finalText) {
    input.response.sendSse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    input.response.sendSse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: input.finalText },
    });
    input.response.sendSse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    input.onAssistantText(input.finalText);
  }

  for (const call of input.externalToolCalls) {
    input.response.sendSse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: call.toolCallId,
        name: call.toolName,
      },
    });
    input.response.sendSse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.input ?? {}),
      },
    });
    input.response.sendSse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }

  input.response.sendSse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: input.stopReason },
    usage: {
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
    },
  });
  input.response.sendSse("message_stop", { type: "message_stop" });
  input.response.end();
}
